# bundeshaushalt-mcp

An [MCP](https://modelcontextprotocol.io/) server for the German federal budget as the Federal
Ministry of Finance publishes it on [bundeshaushalt.de](https://www.bundeshaushalt.de): planned
(Soll) and realised (Ist) figures from 2012 to next year's draft, by ministry, economic group or
function, as tools for AI agents. Read-only, no API key; public data without copyright protection.

The portal's endpoint is an undocumented internal one (`/internalapi/budgetData`): it can change
or disappear without notice.

It is the MCP side of [bundeshaushalt-cli](https://github.com/maschinenlesbar-org/bundeshaushalt-cli),
built on the same typed client, and released with it.

## Install

```bash
npm i -g @maschinenlesbar.org/bundeshaushalt-mcp
```

This installs the **`bundeshaushalt-mcp`** command (Node.js 22.12+). Or run the container
image, for linux/amd64 and linux/arm64, which needs no Node.js:

```bash
docker run -i --rm ghcr.io/maschinenlesbar-org/bundeshaushalt-mcp:latest
```

## Connect a client

The server speaks MCP on stdio by default.

**Claude Code**

```bash
claude mcp add bundeshaushalt -- bundeshaushalt-mcp
# or with the image:
claude mcp add bundeshaushalt -- docker run -i --rm ghcr.io/maschinenlesbar-org/bundeshaushalt-mcp:latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "bundeshaushalt": { "command": "bundeshaushalt-mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "bundeshaushalt": { "type": "stdio", "command": "bundeshaushalt-mcp" } } }
```

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`):

```bash
bundeshaushalt-mcp --transport http            # http://127.0.0.1:3000/mcp
claude mcp add --transport http bundeshaushalt http://127.0.0.1:3000/mcp
```

In a container, publish the port on loopback only:
`docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/maschinenlesbar-org/bundeshaushalt-mcp:latest --transport http --host 0.0.0.0 --allowed-hosts localhost,127.0.0.1`.

For scripts and shared configs, pin a release and its digest from the
[release notes](https://github.com/maschinenlesbar-org/bundeshaushalt-cli/releases) instead of
`latest`: `…/bundeshaushalt-mcp:<version>@sha256:<digest>`. Check an image's provenance with
`gh attestation verify oci://ghcr.io/maschinenlesbar-org/bundeshaushalt-mcp:<version> --repo maschinenlesbar-org/bundeshaushalt-cli`.

## Tools

| Tool | What it answers |
|---|---|
| `getBudgetBreakdown` | A year's budget (or one element of it) ranked by amount, with shares: by ministry (Einzelplan, Kapitel, Titel), economic group or function; drill in with a row's id. A leaf gives its amount, its place in the other groupings and its Haushaltsplan page. |
| `comparePlanToActual` | Planned against realised figures of a year, joined by id: totals, execution rate, the largest over- and underspends, elements in one side only. Without published realised figures: why, and the latest year that has them. |
| `getBudgetTrend` | One figure across years (the whole budget or one element by id), with the change per year and over the span; gaps and renames marked. |
| `getBudgetData` | One view as the portal sends it, its children a page at a time. |

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from, the request as the client sent it (comparePlanToActual cites the plan's
and adds "(and the same with quota=actual)", getBudgetTrend the first year's and "(one request per
year, 2023 to 2027)"; whole, never cut like the data; an answer a redirect fetched from another
host says so there: "… (answered by https://other.example after a redirect)", and a WARN record
names both) and the data licence. A text over 2000 characters is cut and ends in
`…[cut, N characters in all]`, and the answer says `truncated`. An answer over
`--max-result-chars` first loses entries from the end of its page (then `nextOffset` says where to
go on), then has its longest texts cut further (each with that mark) or, when that isn't enough, its
other lists shortened (`reason` names them); a list keeps its first entry, `notes` stay whole, and the answer says
`truncated`. One that can't be cut down so far is a tool error that says to ask for less. A
failure is a tool error that says what to change (one over 5000 characters loses its middle, never
its end, where the reason is): a portal that fails or can't be reached, to try again in a few
minutes; an answer that isn't the portal's data, that its undocumented endpoint may have changed.

## Options

```
--transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
--host <address>           HTTP: the address to listen on (default 127.0.0.1)
--port <n>                 HTTP: the port (default 3000)
--allowed-hosts <list>     HTTP: Host header names to answer (default localhost,127.0.0.1,[::1])
--allowed-origins <list>   HTTP: browser origins allowed to call, exactly (https://app.example.org); none by default
--auth-token-file <path>   HTTP: a file with the bearer token every request must send (mode 600, 32+ characters)
--base-url <url>           API base URL (default https://www.bundeshaushalt.de)
--timeout <ms>             per upstream request (default 30000)
--call-timeout <ms>        per tool call, retries included (default 45000)
--max-result-chars <n>     cap on one tool result's JSON (default 25000)
--max-pages <n>            pages a tool reads per list and call (default 10)
--user-agent <ua>          User-Agent header value (Latin-1, one line)
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **No authentication** on HTTP unless you give one. It listens on loopback by default; it checks
  the `Host` header and, from a browser, the `Origin` (only the origins given with
  `--allowed-origins`, matched exactly) against DNS rebinding and other web pages; a page on one
  of those origins gets CORS (its preflight answered, the answers readable). With
  `--auth-token-file <path>` every request must send `Authorization: Bearer <token>` (the file holds
  one token of at least 32 characters, mode 600, owned by the user the server runs as, a regular
  file (a FIFO is refused at once, never waited on); read once at start; `(umask 077; openssl rand
  -hex 32 > mcp-token)` makes one); anything else is answered 401.
  Exposed beyond localhost (it logs a warning then), it belongs behind a proxy that authenticates or
  at least terminates TLS.
- **Gentle with the upstream.** One server process sends at most 2 requests at a time and 120 a
  minute to the API, pauses the requests to a host that answers HTTP 429 (as long as its Retry-After asks, at most 30 s; those to another host go on), and stops
  a tool call after its deadline (a tool that has read part of its answer by then may answer with
  that part, and says so). A request those limits would hold longer than it or its call may
  wait is not sent: the call fails at once, naming the limit and when to ask again (and the log says
  so).
- **Results are data.** Text from the API, keys included, is cleaned (control, bidi,
  zero-width, tag and other invisible characters removed, but an emoji keeps its joiners; a key that cleaning makes equal to another stays, as `name~2`),
  but it is still other people's text: a model can be told things in it. The server can't act on that (it has no tool that writes), but other tools in the same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new
  connection and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal
  ends it at once. On stdio a signal ends it at once; when stdin ends, it first answers the
  requests it has read (each within its call deadline), then exits.
- **In a container** it needs at least 12 processes and threads (`--pids-limit`) and about
  256 MB of memory.
- **Logs** go to stderr, one record per line; stdout carries only the protocol. A call that fails
  upstream or reaches its deadline leaves a WARN record naming the tool.
- **Never installs anything.**

## Licence

Code: AGPL-3.0-or-later or commercial
([LICENSING.md](https://github.com/maschinenlesbar-org/bundeshaushalt-cli/blob/main/LICENSING.md)).
Data: the Bundesministerium der Finanzen publishes it on bundeshaushalt.de as public data without
copyright protection (it derives from the Bundeshaushaltsplan, an official work): use, also
commercial, is allowed, and attribution is recommended, not required ("Datenquelle: Bundeshaushalt,
Bundesministerium der Finanzen (bundeshaushalt.de)"); the official Bundeshaushaltsplan is
authoritative ([DATA_LICENSE.md](https://github.com/maschinenlesbar-org/bundeshaushalt-cli/blob/main/DATA_LICENSE.md)).
Every result carries this note in its `licence` field.
