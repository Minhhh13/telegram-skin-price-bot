package main

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"

	"go.mau.fi/mautrix-meta/pkg/messagix/table"
)

func testCollector(buffer *bytes.Buffer) *collector {
	return &collector{
		writer:      &writer{enc: json.NewEncoder(buffer)},
		threadID:    456,
		ownID:       123,
		seen:        make(map[string]time.Time),
		acked:       make(map[string]struct{}),
		pending:     make(map[string]*pendingMessage),
		attachments: make(map[string][]attachment),
		startedAt:   time.Now().Add(-time.Minute),
	}
}

func TestCollectorJoinsLaterImageAndAcknowledges(t *testing.T) {
	var buffer bytes.Buffer
	c := testCollector(&buffer)
	now := time.Now().UnixMilli()
	c.message("socket", 456, 789, now, "photo", "!buff", "", false, false)
	if buffer.Len() != 0 {
		t.Fatal("socket message emitted before its attachment arrived")
	}
	c.table("socket", &table.LSTable{LSInsertAttachment: []*table.LSInsertAttachment{{
		ThreadKey: 456, MessageId: "photo", AttachmentType: table.AttachmentTypeImage,
		PlayableUrl: "https://image.fbcdn.net/photo.jpg",
	}}})
	var event output
	if err := json.Unmarshal(bytes.TrimSpace(buffer.Bytes()), &event); err != nil {
		t.Fatal(err)
	}
	if event.MessageID != "photo" || len(event.Attachments) != 1 || event.Attachments[0].Type != "image" {
		t.Fatalf("image was not joined to the request: %+v", event)
	}
	c.ack("photo")
	c.message("snapshot", 456, 789, now, "photo", "!buff", "", false, false)
	if bytes.Count(buffer.Bytes(), []byte{'\n'}) != 1 {
		t.Fatal("acknowledged request was emitted again")
	}
}

func TestCollectorRetriesUnacknowledgedSnapshot(t *testing.T) {
	var buffer bytes.Buffer
	c := testCollector(&buffer)
	now := time.Now().UnixMilli()
	c.message("snapshot", 456, 789, now, "retry", "!buff ak redline ft", "", false, false)
	c.message("snapshot", 456, 789, now, "retry", "!buff ak redline ft", "", false, false)
	if bytes.Count(buffer.Bytes(), []byte{'\n'}) != 1 {
		t.Fatal("request was duplicated during the retry cooldown")
	}
	c.mu.Lock()
	c.seen["retry"] = time.Now().Add(-2 * time.Minute)
	c.mu.Unlock()
	c.message("snapshot", 456, 789, now, "retry", "!buff ak redline ft", "", false, false)
	if bytes.Count(buffer.Bytes(), []byte{'\n'}) != 2 {
		t.Fatal("unacknowledged request was not retried")
	}
}
