// Local-only resource check; no service, provider, or account requests.
import { performance } from 'node:perf_hooks';
import { itemNames } from '../supabase/functions/skin-price-webhook/catalog.mjs';
import { resolveItem, catalogSuggestionsForText } from '../supabase/functions/skin-price-webhook/skin-price.mjs';

const names=Object.freeze([...itemNames]);
const queries=['ak redline ft','awp dragonlroe ft','sticker crown foil','sir bloody loudmouth',
  'glock twilght galxy fn','sunburst minwear','sticker 00 nation gold rio 2022','redlien ft'];
const before=process.memoryUsage().rss,start=performance.now();
for(const query of queries){await resolveItem(query,undefined,names);catalogSuggestionsForText(query,5,names);}
const coldMs=performance.now()-start,times=[];
for(let i=0;i<80;i++){
  const query=queries[i%queries.length],at=performance.now();
  await resolveItem(query,undefined,names);catalogSuggestionsForText(query,5,names);times.push(performance.now()-at);
}
times.sort((a,b)=>a-b);
console.log(JSON.stringify({names:names.length,coldEightQueriesMs:Math.round(coldMs),
  warmMedianMs:Number(times[Math.floor(times.length/2)].toFixed(1)),warmP95Ms:Number(times[Math.floor(times.length*.95)].toFixed(1)),
  rssBeforeMb:Math.round(before/1048576),rssAfterMb:Math.round(process.memoryUsage().rss/1048576)},null,2));
