import { parseMailThreadHeaders } from "./scoped-mail-headers.js";

/** Fixed original JXA. Only its single JSON argv value contains caller data. */
export const SCOPED_MAIL_JXA = String.raw`function run(argv) {
  "use strict";
  if (argv.length !== 1) throw new Error("Invalid scoped Mail invocation");
  var p = JSON.parse(argv[0]);
  if (["list", "search", "get", "snapshot"].indexOf(p.op) < 0) throw new Error("Mail action is read-only");
  var Mail = Application("/System/Applications/Mail.app");
  if (!Mail.running()) throw new Error("Mail must already be running");
  var parseHeaders = ${parseMailThreadHeaders.toString()};
  function resolveMailbox(record) {
    var accounts = Mail.accounts.whose({id:record.accountId})().filter(function(a) {
      // Exact ID is a native predicate; provider is checked before all other fields.
      if (a.accountType() !== "iCloud") throw new Error("Allowed Mail account provider is not iCloud");
      return a.id() === record.accountId;
    });
    if (accounts.length !== 1) throw new Error("Allowed Mail account is missing or ambiguous");
    var parent = accounts[0];
    for (var level = 0; level < record.path.length; level++) {
      var segment = record.path[level];
      var matches = parent.mailboxes.whose({name:segment})().filter(function(mb) {
        var owner = mb.account();
        if (owner.accountType() !== "iCloud") throw new Error("Allowed Mail mailbox provider is not iCloud");
        if (owner.id() !== record.accountId) throw new Error("Allowed Mail mailbox owner does not match its scoped account");
        return mb.name() === segment;
      });
      if (matches.length !== 1) throw new Error("Allowed Mail mailbox path is missing or ambiguous");
      parent = matches[0];
    }
    return parent;
  }
  function locate(record, localId, expectedRFC) {
    var mailbox = resolveMailbox(record);
    var messages = mailbox.messages.whose({id:Number(localId)})().filter(function(m) { return String(m.id()) === localId; });
    if (messages.length !== 1) throw new Error("Message is outside the allowed mailbox, missing, or ambiguous");
    var message = messages[0];
    if (expectedRFC !== undefined && String(message.messageId() || "").replace(/^<|>$/g, "") !== expectedRFC) throw new Error("Mail message identity changed");
    return message;
  }
  function clip(value, cap) { var text = String(value || ""); return {value:text.slice(0,cap),truncated:text.length > cap}; }
  function metadata(record, localId, skipOutOfWindow) {
    var message = locate(record, localId);
    var received = message.dateReceived();
    if (!(received instanceof Date) || !isFinite(received.getTime())) throw new Error("Mail message received date is invalid");
    if (received.getTime() < p.sinceEpoch || received.getTime() > p.untilEpoch) {
      if (skipOutOfWindow === true) return null;
      throw new Error("Mail message is outside the bounded date window");
    }
    var subjectText = clip(message.subject(), 4096), senderText = clip(message.sender(), 4096);
    var rfcId = String(message.messageId() || "").replace(/^<|>$/g, "");
    if (rfcId.length > 998 || /[<>\s]/.test(rfcId)) rfcId = "";
    return {id:localId,messageId:rfcId,accountId:record.accountId,mailboxId:record.id,subject:subjectText.value,sender:senderText.value,dateReceived:received.toISOString(),isRead:Boolean(message.readStatus()),metadataTruncated:subjectText.truncated || senderText.truncated};
  }
  function fullMessage(record, localId, expectedRFC) {
    var data = metadata(record, localId);
    if (expectedRFC !== undefined && data.messageId !== expectedRFC) throw new Error("Mail message identity changed");
    var message = locate(record, localId, data.messageId);
    var beforeRead = Boolean(message.readStatus());
    var bodyText = clip(message.content(), 16384);
    var afterRead = Boolean(message.readStatus());
    if (beforeRead !== afterRead) throw new Error("Read-only Mail content access changed read status; stop and verify locally");
    locate(record, localId, data.messageId);
    data.content = bodyText.value; data.contentTruncated = bodyText.truncated;
    data.isRead = afterRead; data.attachmentsOmitted = true;
    return data;
  }
  var selected = p.mailboxes.filter(function(record) { return record.id === p.mailboxId && record.accountId === p.accountId; });
  if (selected.length !== 1) throw new Error("Mail request lacks an exact allowed account/mailbox scope");
  if (p.op === "get") return JSON.stringify({success:true,message:fullMessage(selected[0],p.id,p.expectedRFC)});
  var records = p.op === "snapshot" ? p.mailboxes.filter(function(record) { return record.accountId === p.accountId; }) : selected;
  var output = [], seen = {}, inspected = 0, eligibleCount = 0, scanTruncated = false;
  if (p.op === "snapshot") {
    var seed = metadata(selected[0],p.id);
    var seedMessage = locate(selected[0],p.id,seed.messageId);
    seed.threadHeaders = parseHeaders(String(seedMessage.allHeaders() || ""));
    seed.key = seed.mailboxId + "/" + seed.id;
    output.push(seed); seen[seed.key] = true; inspected = 1; eligibleCount = 1;
  }
  for (var boxIndex = 0; boxIndex < records.length; boxIndex++) {
    var record = records[boxIndex], mailbox = resolveMailbox(record);
    var candidates = mailbox.messages.whose({dateReceived:{">=":new Date(p.sinceEpoch)}})();
    for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
      var localId = String(candidates[candidateIndex].id()), key = record.id + "/" + localId;
      if (seen[key]) continue;
      if (inspected >= 200) { scanTruncated = true; break; }
      inspected++;
      var data = metadata(record,localId,true);
      seen[key] = true;
      // New arrivals after the fixed request clock never reach metadata/body/header getters.
      if (data === null) continue;
      eligibleCount++;
      if (p.op === "search" && (data.subject + "\n" + data.sender).toLowerCase().indexOf(p.query.toLowerCase()) < 0) continue;
      if (p.op === "snapshot") {
        data.threadHeaders = parseHeaders(String(locate(record,localId,data.messageId).allHeaders() || ""));
        data.key = key;
      }
      output.push(data);
    }
  }
  output.sort(function(a,b) { return Date.parse(b.dateReceived) - Date.parse(a.dateReceived) || (a.id < b.id ? -1 : 1); });
  var resultLimited = p.op !== "snapshot" && output.length > p.limit;
  if (p.op !== "snapshot") output = output.slice(0,p.limit);
  return JSON.stringify({success:true,messages:output,coverage:{since:p.since,until:p.until,inspected:inspected,eligibleCount:eligibleCount,scanTruncated:scanTruncated,resultLimited:resultLimited,ordering:"newest among inspected candidates",historicalConversationComplete:false}});
}
`;
