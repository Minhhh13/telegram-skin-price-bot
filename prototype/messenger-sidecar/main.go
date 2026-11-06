// Messenger bridge for the one approved group. It exchanges JSON lines with
// the Node service and never prints session cookies.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/mautrix-meta/pkg/messagix"
	"go.mau.fi/mautrix-meta/pkg/messagix/cookies"
	"go.mau.fi/mautrix-meta/pkg/messagix/methods"
	"go.mau.fi/mautrix-meta/pkg/messagix/socket"
	"go.mau.fi/mautrix-meta/pkg/messagix/table"
	"go.mau.fi/mautrix-meta/pkg/messagix/types"
)

type output struct {
	Type        string       `json:"type"`
	Source      string       `json:"source,omitempty"`
	MessageID   string       `json:"message_id,omitempty"`
	ThreadID    string       `json:"thread_id,omitempty"`
	SenderID    string       `json:"sender_id,omitempty"`
	Text        string       `json:"text,omitempty"`
	Mentions    []mention    `json:"mentions,omitempty"`
	Attachments []attachment `json:"attachments,omitempty"`
	TimestampMS int64        `json:"timestamp_ms,omitempty"`
	State       string       `json:"state,omitempty"`
	RequestID   string       `json:"request_id,omitempty"`
	OK          bool         `json:"ok,omitempty"`
	Error       string       `json:"error,omitempty"`
	Inserted    int          `json:"inserted,omitempty"`
	Upserted    int          `json:"upserted,omitempty"`
	Replaced    int          `json:"replaced,omitempty"`
	TargetCount int          `json:"target_count,omitempty"`
	NewestMS    int64        `json:"newest_target_ms,omitempty"`
}

type mention struct {
	ID string `json:"id"`
}
type attachment struct {
	Type string `json:"type"`
	URL  string `json:"url"`
}

type tableStats struct {
	inserted, upserted, replaced, targetCount int
	newestMS                                  int64
}

func (s tableStats) status(state string) output {
	return output{
		Type: "status", State: state,
		Inserted: s.inserted, Upserted: s.upserted, Replaced: s.replaced,
		TargetCount: s.targetCount, NewestMS: s.newestMS,
	}
}

type input struct {
	Type      string `json:"type"`
	RequestID string `json:"request_id"`
	MessageID string `json:"message_id"`
	ThreadID  string `json:"thread_id"`
	Text      string `json:"text"`
	ReplyTo   string `json:"reply_to"`
}

type writer struct {
	mu  sync.Mutex
	enc *json.Encoder
}

func (w *writer) emit(event output) {
	w.mu.Lock()
	defer w.mu.Unlock()
	_ = w.enc.Encode(event)
}

type collector struct {
	writer      *writer
	threadID    int64
	ownID       int64
	seen        map[string]time.Time
	acked       map[string]struct{}
	pending     map[string]*pendingMessage
	attachments map[string][]attachment
	mu          sync.Mutex
	startedAt   time.Time
}

type pendingMessage struct {
	event output
	timer *time.Timer
}

func (c *collector) ack(id string) {
	if id == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.acked[id] = struct{}{}
	delete(c.attachments, id)
	if pending := c.pending[id]; pending != nil {
		pending.timer.Stop()
		delete(c.pending, id)
	}
	if len(c.acked) > 2000 {
		for oldID := range c.acked {
			delete(c.acked, oldID)
			break
		}
	}
}

func (c *collector) flush(id string) {
	c.mu.Lock()
	pending := c.pending[id]
	if pending == nil {
		c.mu.Unlock()
		return
	}
	delete(c.pending, id)
	if _, alreadyAcked := c.acked[id]; alreadyAcked {
		c.mu.Unlock()
		return
	}
	pending.timer.Stop()
	event := pending.event
	event.Attachments = append([]attachment(nil), c.attachments[id]...)
	if event.Text == "" && len(event.Attachments) == 0 {
		c.mu.Unlock()
		return
	}
	c.seen[id] = time.Now()
	c.mu.Unlock()
	c.writer.emit(event)
}

func (c *collector) message(source string, threadID, senderID, timestampMS int64, id, body, mentionIDs string, unsent, admin bool) {
	if threadID != c.threadID || senderID == c.ownID || id == "" || unsent || admin {
		return
	}
	if timestampMS < c.startedAt.UnixMilli() {
		return
	}
	c.mu.Lock()
	if _, exists := c.acked[id]; exists {
		c.mu.Unlock()
		return
	}
	if lastEmitted, exists := c.seen[id]; exists && time.Since(lastEmitted) < 90*time.Second {
		c.mu.Unlock()
		return
	}
	if _, queued := c.pending[id]; queued {
		c.mu.Unlock()
		return
	}
	attached := append([]attachment(nil), c.attachments[id]...)
	if body == "" && len(attached) == 0 && source != "socket" {
		c.mu.Unlock()
		return
	}
	if len(c.seen) > 2000 {
		for messageID, seenAt := range c.seen {
			if time.Since(seenAt) > 24*time.Hour {
				delete(c.seen, messageID)
			}
		}
	}
	var mentions []mention
	for _, value := range strings.Split(mentionIDs, ",") {
		if value != "" {
			mentions = append(mentions, mention{ID: value})
		}
	}
	event := output{
		Type:        "message",
		Source:      source,
		MessageID:   id,
		ThreadID:    strconv.FormatInt(threadID, 10),
		SenderID:    strconv.FormatInt(senderID, 10),
		Text:        body,
		Mentions:    mentions,
		Attachments: attached,
		TimestampMS: timestampMS,
	}
	if source == "socket" && len(attached) == 0 {
		pending := &pendingMessage{event: event}
		c.pending[id] = pending
		delay := 750 * time.Millisecond
		if body == "" {
			delay = 5 * time.Second
		}
		pending.timer = time.AfterFunc(delay, func() { c.flush(id) })
		c.mu.Unlock()
		return
	}
	c.seen[id] = time.Now()
	c.mu.Unlock()
	c.writer.emit(event)
}

func (c *collector) table(source string, tbl *table.LSTable) tableStats {
	if tbl == nil {
		return tableStats{}
	}
	stats := tableStats{
		inserted: len(tbl.LSInsertMessage), upserted: len(tbl.LSUpsertMessage),
		replaced: len(tbl.LSDeleteThenInsertMessage),
	}
	addAttachment := func(messageID, url string, attachmentType table.AttachmentType) {
		if messageID == "" || url == "" || attachmentType != table.AttachmentTypeImage {
			return
		}
		c.mu.Lock()
		for _, previous := range c.attachments[messageID] {
			if previous.URL == url {
				c.mu.Unlock()
				return
			}
		}
		c.attachments[messageID] = append(c.attachments[messageID], attachment{Type: "image", URL: url})
		_, pending := c.pending[messageID]
		if len(c.attachments) > 2000 {
			for oldID := range c.attachments {
				if oldID != messageID {
					delete(c.attachments, oldID)
					break
				}
			}
		}
		c.mu.Unlock()
		if pending {
			c.flush(messageID)
		}
	}
	for _, a := range tbl.LSInsertAttachment {
		if a != nil && a.ThreadKey == c.threadID {
			url := a.PlayableUrl
			if url == "" {
				url = a.PreviewUrl
			}
			addAttachment(a.MessageId, url, a.AttachmentType)
		}
	}
	for _, a := range tbl.LSInsertBlobAttachment {
		if a != nil && a.ThreadKey == c.threadID {
			url := a.PlayableUrl
			if url == "" {
				url = a.PreviewUrl
			}
			addAttachment(a.MessageId, url, a.AttachmentType)
		}
	}
	countTarget := func(threadID, timestampMS int64) {
		if threadID != c.threadID {
			return
		}
		stats.targetCount++
		if timestampMS > stats.newestMS {
			stats.newestMS = timestampMS
		}
	}
	for _, m := range tbl.LSInsertMessage {
		if m != nil {
			countTarget(m.ThreadKey, m.TimestampMs)
			c.message(source, m.ThreadKey, m.SenderId, m.TimestampMs, m.MessageId, m.Text, m.MentionIds, m.IsUnsent, m.IsAdminMessage)
		}
	}
	for _, m := range tbl.LSUpsertMessage {
		if m != nil {
			countTarget(m.ThreadKey, m.TimestampMs)
			c.message(source, m.ThreadKey, m.SenderId, m.TimestampMs, m.MessageId, m.Text, m.MentionIds, m.IsUnsent, m.IsAdminMessage)
		}
	}
	for _, m := range tbl.LSDeleteThenInsertMessage {
		if m != nil {
			countTarget(m.ThreadKey, m.TimestampMs)
			c.message(source, m.ThreadKey, m.SenderId, m.TimestampMs, m.MessageId, m.Text, m.MentionIds, m.IsUnsent, m.IsAdminMessage)
		}
	}
	return stats
}

func parseCookies(raw string) (*cookies.Cookies, error) {
	parsed := make(map[cookies.MetaCookieName]string)
	for _, entry := range strings.Split(raw, ";") {
		name, value, ok := strings.Cut(strings.TrimSpace(entry), "=")
		if ok && name != "" {
			parsed[cookies.MetaCookieName(name)] = value
		}
	}
	c := &cookies.Cookies{Platform: types.Facebook}
	c.UpdateValues(parsed)
	if len(c.GetMissingCookieNames()) > 0 || c.GetUserID() == 0 {
		return nil, fmt.Errorf("required Facebook session cookies are missing")
	}
	return c, nil
}

func sendMessage(ctx context.Context, client *messagix.Client, targetThreadID int64, request input) error {
	threadID, err := strconv.ParseInt(request.ThreadID, 10, 64)
	if err != nil || threadID != targetThreadID {
		return fmt.Errorf("message targets an unapproved thread")
	}
	if request.Text == "" || len(request.Text) > 16000 {
		return fmt.Errorf("message text length is invalid")
	}
	if err := client.WaitUntilCanSendMessages(ctx, 10*time.Second); err != nil {
		return fmt.Errorf("Messenger socket is not ready to send")
	}
	task := &socket.SendMessageTask{
		ThreadId:          threadID,
		Otid:              methods.GenerateEpochID(),
		Source:            table.MESSENGER_INBOX_IN_THREAD,
		InitiatingSource:  table.FACEBOOK_INBOX,
		SendType:          table.TEXT,
		SyncGroup:         1,
		Text:              request.Text,
		SkipUrlPreviewGen: 1,
	}
	if request.ReplyTo != "" {
		task.ReplyMetaData = &socket.ReplyMetaData{ReplyMessageId: request.ReplyTo, ReplySourceType: 1}
	}
	response, err := client.ExecuteTasks(ctx, task)
	if err != nil {
		return err
	}
	if response == nil {
		return fmt.Errorf("Messenger did not confirm the message")
	}
	for _, failed := range response.LSMarkOptimisticMessageFailed {
		if failed != nil {
			return fmt.Errorf("Messenger rejected the message")
		}
	}
	for _, failed := range response.LSHandleFailedTask {
		if failed != nil {
			return fmt.Errorf("Messenger rejected the message task")
		}
	}
	for _, confirmed := range response.LSReplaceOptimsiticMessage {
		if confirmed != nil && confirmed.OfflineThreadingId == strconv.FormatInt(task.Otid, 10) && confirmed.MessageId != "" {
			return nil
		}
	}
	return fmt.Errorf("Messenger did not confirm the message")
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	threadID, err := strconv.ParseInt(os.Getenv("MESSENGER_THREAD_ID"), 10, 64)
	if err != nil || threadID == 0 {
		fmt.Fprintln(os.Stderr, "MESSENGER_THREAD_ID must be a numeric group thread ID")
		os.Exit(2)
	}
	accountCookies, err := parseCookies(os.Getenv("MESSENGER_COOKIES"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if expected := os.Getenv("MESSENGER_EXPECTED_USER_ID"); expected != "" && expected != strconv.FormatInt(accountCookies.GetUserID(), 10) {
		fmt.Fprintln(os.Stderr, "Messenger session is for the wrong account")
		os.Exit(2)
	}
	w := &writer{enc: json.NewEncoder(os.Stdout)}
	acceptAfterMS, err := strconv.ParseInt(os.Getenv("MESSENGER_ACCEPT_AFTER_MS"), 10, 64)
	if err != nil || acceptAfterMS <= 0 || acceptAfterMS > time.Now().Add(time.Minute).UnixMilli() {
		fmt.Fprintln(os.Stderr, "MESSENGER_ACCEPT_AFTER_MS must be a recent Unix millisecond timestamp")
		os.Exit(2)
	}
	c := &collector{
		writer:      w,
		threadID:    threadID,
		ownID:       accountCookies.GetUserID(),
		seen:        make(map[string]time.Time),
		acked:       make(map[string]struct{}),
		pending:     make(map[string]*pendingMessage),
		attachments: make(map[string][]attachment),
		startedAt:   time.UnixMilli(acceptAfterMS),
	}
	logger := zerolog.Nop()
	live := messagix.NewClient(accountCookies, logger, &messagix.Config{})
	live.SetEventHandler(func(_ context.Context, event any) {
		switch e := event.(type) {
		case *table.LSTable:
			stats := c.table("socket", e)
			if stats.targetCount > 0 {
				w.emit(stats.status("socket_batch"))
			}
		case *messagix.ConnectedEvent, *messagix.ReconnectedEvent:
			w.emit(output{Type: "status", State: "socket_connected"})
		case *messagix.TransientDisconnectEvent:
			w.emit(output{Type: "status", State: "socket_disconnected"})
		case *messagix.PermanentErrorEvent:
			w.emit(output{Type: "status", State: "socket_error"})
		}
	})
	pageCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	_, initial, err := live.LoadMessagesPage(pageCtx)
	cancel()
	if err != nil {
		fmt.Fprintf(os.Stderr, "initial Messenger inbox load failed: %v\n", err)
		os.Exit(1)
	}
	w.emit(c.table("initial", initial).status("inbox_loaded"))
	if err := live.Connect(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "Messenger socket start failed: %v\n", err)
	}
	defer live.Disconnect()
	go func() {
		reader := bufio.NewReader(os.Stdin)
		decoder := json.NewDecoder(reader)
		for {
			var request input
			if err := decoder.Decode(&request); err != nil {
				return
			}
			if request.Type == "ack" {
				c.ack(request.MessageID)
				continue
			}
			if request.Type != "send" || request.RequestID == "" {
				continue
			}
			go func(request input) {
				sendCtx, cancel := context.WithTimeout(ctx, 35*time.Second)
				defer cancel()
				err := sendMessage(sendCtx, live, threadID, request)
				response := output{Type: "sent", RequestID: request.RequestID, OK: err == nil}
				if err != nil {
					response.Error = err.Error()
				}
				w.emit(response)
			}(request)
		}
	}()

	// The second client avoids mutating the live client's sync manager while it
	// handles socket events. This fallback covers socket sync failures and gaps.
	pollCookies, err := parseCookies(os.Getenv("MESSENGER_COOKIES"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "Messenger poller session invalid")
		os.Exit(2)
	}
	poller := messagix.NewClient(pollCookies, logger, &messagix.Config{})
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pollCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
			_, snapshot, err := poller.LoadMessagesPage(pollCtx)
			cancel()
			if err != nil {
				w.emit(output{Type: "status", State: "poll_failed"})
				continue
			}
			w.emit(c.table("snapshot", snapshot).status("poll_ok"))
		}
	}
}
