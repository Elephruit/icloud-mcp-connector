/** Pure bounded RFC relationships; no subject grouping or mailbox fallback. */
export function parseMailThreadHeaders(rawHeaders) {
  var result = { messageId: "", references: [], inReplyTo: [], malformed: false, truncated: false };
  if (typeof rawHeaders !== "string") { result.malformed = true; return result; }
  if (rawHeaders.length > 8192) { result.truncated = true; result.malformed = true; return result; }
  var unfolded = rawHeaders.replace(/\r?\n[ \t]+/g, " ");
  var fields = {};
  unfolded.split(/\r?\n/).forEach(function (line) {
    var match = /^(message-id|references|in-reply-to):[ \t]*(.*)$/i.exec(line);
    if (!match) return;
    var name = match[1].toLowerCase();
    if (Object.prototype.hasOwnProperty.call(fields, name)) { result.malformed = true; return; }
    fields[name] = match[2];
  });
  function ids(value) {
    if (value === undefined) return [];
    var matches = [], expression = /<([^<>\s]{1,998})>/g, match;
    while ((match = expression.exec(value)) !== null) matches.push(match[1]);
    if (matches.length > 64 || !matches.length || value.replace(/<[^<>\s]{1,998}>/g, "").trim()) { result.malformed = true; return []; }
    if ((new Set(matches)).size !== matches.length) { result.malformed = true; return []; }
    return matches;
  }
  var ownIds = ids(fields["message-id"]);
  if (ownIds.length === 1) result.messageId = ownIds[0];
  else result.malformed = true;
  result.references = ids(fields.references);
  result.inReplyTo = ids(fields["in-reply-to"]);
  return result;
}

export function selectMailThread(messages, seedKey) {
  const seed = messages.find((message) => message.key === seedKey);
  if (!seed || seed.threadHeaders.malformed || seed.threadHeaders.truncated || !seed.threadHeaders.messageId) throw new Error("Mail thread seed lacks unambiguous bounded RFC headers");
  const byRFC = new Map();
  const adjacency = new Map();
  const connect = (a, b) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a).add(b); adjacency.get(b).add(a);
  };
  for (const message of messages) {
    const headers = message.threadHeaders;
    if (headers.malformed || headers.truncated || !headers.messageId) continue;
    if (byRFC.has(headers.messageId)) throw new Error("Mail thread relationships contain ambiguous duplicate RFC message IDs");
    byRFC.set(headers.messageId, message);
    connect(headers.messageId, headers.messageId);
    for (const related of [...headers.references, ...headers.inReplyTo]) connect(headers.messageId, related);
  }
  const visited = new Set([seed.threadHeaders.messageId]), pending = [seed.threadHeaders.messageId];
  for (let index = 0; index < pending.length; index += 1) {
    for (const neighbor of adjacency.get(pending[index]) ?? []) if (!visited.has(neighbor)) { visited.add(neighbor); pending.push(neighbor); }
  }
  return messages.filter((message) => !message.threadHeaders.malformed && !message.threadHeaders.truncated && visited.has(message.threadHeaders.messageId));
}
