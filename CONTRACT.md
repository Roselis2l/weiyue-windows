# 模块约定（共同实现）

Version 1.1.16. CommonJS / Node built-ins in the Electron main process; fixed local libheif-js and PDF.js assets are distributed with the app. No startup package installation or runtime CDN.

Canonical message: `{id:string,groupId:string,senderId:string,senderName:string,text:string,time:number}` (epoch ms).
Group: `{id:string,name:string,selected?:boolean,coverage?:{oldest:number,newest:number,complete:boolean,note:string}}`.
Account: `{id:string,name:string,kind:'demo'|'import'|'weibo'}`.
All IDs string; unsafe numeric imported IDs rejected. Message time range `[start,end)`.

## core/store.cjs
Export `Store`. Constructor(root), `accounts()`, `account(id)`, `ensureAccount({id,name,kind})`, `get(id)` returns state, `update(id, mutator)` atomic persist. State `{account,groups:[],messages:[],bookmarks:[],summaries:[],readPositions:{},importantMembers:[],settings:{},exports:{}}`.
`mergeMessages(accountId,groups,messages)` validates dedup groupId+id returns count; `queryMessages(accountId,{groupId,keyword,senderId,start,end,importantOnly,limit,offset})` returns `{messages,total}` sorted time ascending then numeric ID; `bookmark(accountId,{messageIds,groupId,note,tags})` returns bookmark `{id,groupId,messageIds,note,tags,createdAt}`; `bookmarks(accountId,query)` returns enriched bookmark list with `messages`; `removeBookmark(accountId,id)`; `setReadPosition(accountId,groupId,messageId)`; `setImportant(accountId,senderId,enabled)`; `importData(accountId,data)`; `seedDemo()` returns account. Export `normalizeMessage`, `filterMessages` if useful. Local JSON atomic store with schema validation, account paths hashed, no secrets in settings.

## core/weibo.cjs
Export `WeiboClient` constructor({fetch, sleep?}) where fetch API supplied Electron session.fetch; `identity()` -> `{id,name}`; `groups()` -> groups; `syncGroup(groupId,{maxPages=20,onPage?,before?,signal?})` -> `{messages,coverage,nextCursor,pages}`. Max_mid decimal min ID minus one; precision safe JSON numeric parser; retries bounded network/429/5xx, stop auth/risk/errors. Exports helper parsers/testable functions. Credentials never returned/logged. URLs fixed api.weibo.com only. Can read reference source after clone completes; root agent handles checkout.

## Continuous synchronization (1.1.16)

Latest synchronization preserves durable `latestPendingRanges`, with `latestPending` as a compatibility view. It rotates selected groups, interleaves head reads, and persists each successful page before continuing. Request size remains 20; automatic batches use at most 60 pages/40 seconds, manual batches 120 pages/90 seconds, with at least one second between page requests. Cursor progress uses decimal message IDs and never treats local duplicates or a premature empty page as proof that a gap is closed. Historical fetching remains separate and starts before the oldest local message.

The captured account `AutoSync` policy guards synchronization and legacy content enrichment. A 429 response stops the batch and retains the server cooldown; authentication, permission, risk-control and ignored-cursor failures pause requests for explicit user recovery. Account switching must not attribute an old request's failure to the new account. Synchronization does not advance reading high-water marks.

`scripts/lib/offline-merge.cjs` merges isolated account states by group and stable message ID, retains destination settings and reading marks, adds only recovered messages beyond the prior read boundary to unread IDs, and archives conflicting variants. Historical backups are coverage evidence; backup-only saved items are not implicitly resurrected. Installation data and private migration archives must never enter source or portable distributions.

## Reading filters and navigation (1.1.14)

`messages.query` additionally accepts `senderIds:string[]`: omitted/empty means all senders, nonempty is an exact normalized-ID OR set; a simultaneously supplied legacy `senderId` intersects this set. All other filters intersect it. `messages.locate` uses the same exported `compareMessages` ordering as the query.

The reading UI accepts strict minute-resolution China wall times. `WeiyueFilters.parseChinaMinuteRange(start,end)` maps start to UTC+08:00 minute start and end to the next minute exclusive, rejecting inverted selected minutes before conversion. The core retains `[start,end)` epoch milliseconds; summary time semantics are unchanged.

`readStates[groupId].readThroughId` is the persisted monotonic high-water mark, separate from `anchorId`/`anchorOffset`. The new latest-read button loads a window around this exact ID using `messages.locate`, clears obstructing filters and writes only an anchor. It never sends `readThroughId` to `read.set`. Only validated native reading intent or the distinct explicit “加载到最新” action can advance the mark. No read-state schema migration is required.

The member picker preserves its search input node and selection set during queries, list updates and IME composition. Selected IDs, not names or visible rows, determine the query.

## core/summary.cjs & core/notion.cjs
Summary exports `prepareSummary({messages,group,start,end})` -> `{messages,chunks,warning,range:{start,end},title}`; `localSummary(prepared)` -> `{id,title,body,refs:[{id,groupId,time,text}],start,end,groupId,warning,mode:'local',createdAt}`; `aiSummary(prepared,{endpoint,key,model,fetch})` async same summary shape; explicit per-request consent enforced by caller. `validateEndpoint(endpoint)` exported, HTTPS only (localhost http optional if clearly validated). Chunks bounded, stable refs `[M1]`, unknown AI refs removed/flagged. Whole long message splitting no loss. No background calls.
Notion exports `NotionClient` constructor({token,fetch}), `listTargets()` -> [{id,title}], `preview(summary,targetId)` -> {title,blocks,...}; `exportSummary(summary,targetId,{journal,saveJournal})` -> {pageId,url,status}. Journal persisted BEFORE writes, uncertain requests must reconcile or stop and require explicit user handling; do not blindly duplicate after network failure. Robust retry 429, no blind retry uncertain POST; idempotent per summary+target. Use Notion stable documented API and preserve citations in content.

## Renderer bridge
`window.api.call(action,payload)` returns plain JSON or rejects sanitized message. Actions state, account.switch, demo, groups.select, sync, messages.query, read.set, important.set, bookmark.add/list/remove, import, export.bookmarks, summary.preview/local/ai/list/delete, settings.save, login.open/complete, logout, notion.targets/preview/export, external.open. Root owns main/preload and renderer, integration.

## Local summary deletion (1.1.15)

`summary.delete.preview` accepts stable `{accountId,summaryId,groupId}` strings and returns the selected title plus a random, short-lived `confirmationToken`. The application displays an HTML confirmation dialog with cancellation as the default. A confirmed `summary.delete` request includes the same IDs, token and `confirmed:true`. The main process consumes the token once and checks its account epoch, group, target ID, expiry and saved target fingerprint; a stale target or changed account is rejected. The preview store is bounded to 32 entries with a five-minute TTL; the token never carries credentials.

`Store.removeSummary(accountId,summaryId,groupId)` removes only the exact matching summary and persists atomically. Cancellation and failed persistence keep the summary and revision unchanged. The renderer removes the card only after a successful response; identity does not depend on title or array position. Restart reads the persisted result.

Deletion changes only `summaries`. Chat messages, bookmarks, reading state, other accounts, export journals and existing Notion pages remain unchanged. There is no network request or remote deletion.

## Notion submission (1.1.15)

The preview's explicit confirm-export button submits the reviewed target and edited snapshot directly, without a second consent checkbox or native confirmation dialog. Target and field validation, account binding, in-flight duplicate prevention, durable export journals, failure handling and confirmed result links remain in force. The references checkbox controls content inclusion and is separate from send confirmation. AI sending retains its own consent flow.

## Media contracts (1.1.12)

`fetchImage({url,fetch,signal,allowHeif:false})` retains JPEG/PNG/GIF/WebP MIME and signature checks by default. Image display explicitly opts into `allowHeif:true`; only strict HEVC-specific HEIF brands with a supported declared MIME return `{bytes,mime:'image/heic'}`. Generic BMFF or an extension is insufficient. Avatar and AI callers do not inherit this opt-in.

The HEIC decoder runs locally in a separate sandbox and terminable worker. Input is at most 20 MiB; display PNG is at most 64 MiB. Pixel/dimension and time budgets are enforced by the decoder. The image viewer receives `{bytes:displayPng,mime:'image/png',original:{bytes:heic,mime:'image/heic'}}`, displays PNG and saves the unchanged original with `.heic` / `.heif`. Ordinary image contracts remain unchanged. Cache accounting includes both buffers and is account scoped.

PDF/video attachment descriptors must originate in explicit, validated message metadata. Fetches use the current authorized account and a restricted media proxy, never renderer-supplied arbitrary URLs. PDF is limited to 50 MiB and rendered to canvas using the bundled PDF.js without document scripting. Videos are limited to 200 MiB and supported MP4/WebM containers; playback depends on Electron codec support, exposes native controls and never starts audible playback automatically. A dedicated viewer can save validated original files through the native file dialog. Account changes invalidate outstanding viewers and reads.

Message HTTP/HTTPS links are text-derived display links, not application instructions. The renderer uses safe text nodes and a restricted external-open bridge; clicking a validated link opens the system default browser without an additional confirmation dialog. Media display does not expand AI/Notion consent or content scope. Reading anchors, unread state and Chinese composition behavior must remain unchanged while media loads.

Release source and portable packages include the reference MIT notice, runtime notices, libheif/libde265 corresponding source and rebuild materials, and PDF.js/font licenses. Private diagnostics, real messages, account files, credentials and installation backups are excluded. Test counts and real-target acceptance must be recorded only after execution.

## Inline emoticons (1.1.15)
`renderer/emoticon-manifest.js` maps every name in the reviewed official public directory to a bundled asset. `renderer/emoticons/catalog-source.json` preserves the original directory bytes; `catalog-manifest.json` records source hash, retrieval, each mapping and unique resource counts. This snapshot has 308 names and 307 unique PNG resources: two official URLs return the same unchanged asset bytes. It does not contain an authenticated chat-specific or official animated GIF catalog.

`renderer/emoticons.js` tokenizes only confirmed bracket codes outside URLs and restores original code on user copy. `core/emoticon-assets.cjs` serves only fixed manifest paths after format/hash validation, with bounded in-memory caching. Canonical message text/images never change; `.emoticon-image` is decorative and excluded from reading media readiness. Release validation compares the entire metadata-name set, exact source URLs, catalog descriptors and every unique resource hash, not a hardcoded three-image list.
