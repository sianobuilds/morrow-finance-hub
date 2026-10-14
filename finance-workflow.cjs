
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "data");

function read(name, fallback) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(dir, name + ".json"), "utf8")
    );
  } catch {
    return fallback;
  }
}

function write(name, value) {
  const file = path.join(dir, name + ".json");
  const temp = file + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

function send(res, code, value) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(value));
}

async function body(req) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 100000) throw Error("Request too large");
  }
  return JSON.parse(data || "{}");
}

function evaluate(invoice, invoices) {
  const rules = {
    autoApprove: false,
    autoApproveMax: 500,
    seniorThreshold: 2500,
    blockDuplicates: true,
    requireValid: true,
    manualCategories: ["Professional Services"],
    ...read("rules", {})
  };

  const issues = [];

  if (!invoice.supplier) issues.push("Missing supplier");
  if (!invoice.number) issues.push("Missing invoice number");
  if (!invoice.invoiceDate) issues.push("Missing invoice date");
  if (!invoice.dueDate) issues.push("Missing due date");
  if (!(Number(invoice.amount) > 0)) issues.push("Invalid amount");

  if (
    invoice.invoiceDate &&
    invoice.dueDate &&
    invoice.dueDate < invoice.invoiceDate
  ) {
    issues.push("Due date before invoice date");
  }

  const duplicate = invoices.some(other =>
    other.id !== invoice.id &&
    String(other.supplier || "").trim().toLowerCase() ===
      String(invoice.supplier || "").trim().toLowerCase() &&
    String(other.number || "").trim().toLowerCase() ===
      String(invoice.number || "").trim().toLowerCase() &&
    Boolean(invoice.number)
  );

  const reasons = [];

  if (duplicate && rules.blockDuplicates)
    reasons.push("Duplicate invoice");

  if (issues.length && rules.requireValid)
    reasons.push(...issues);

  if ((rules.manualCategories || []).includes(invoice.glCategory))
    reasons.push("Manual review category");

  if (Number(invoice.amount) > Number(rules.seniorThreshold))
    reasons.push("Senior approval required");

  if (!rules.autoApprove)
    reasons.push("Automatic approval disabled");

  if (Number(invoice.amount) > Number(rules.autoApproveMax))
    reasons.push("Above automatic approval limit");

  return {
    eligible: reasons.length === 0,
    issues,
    reasons
  };
}

async function handle(req, res, url) {
  const p = url.pathname;

  if (p === "/api/automation/evaluate" && req.method === "POST") {
    const input = await body(req);
    const invoices = read("invoices", []);
    const invoice = invoices.find(x => x.id === input.invoiceId);

    if (!invoice)
      return send(res, 404, {error:"Invoice not found"});

    return send(res, 200, evaluate(invoice, invoices));
  }

  if (p === "/api/automation/apply" && req.method === "POST") {
    const input = await body(req);
    const invoices = read("invoices", []);
    const invoice = invoices.find(x => x.id === input.invoiceId);

    if (!invoice)
      return send(res, 404, {error:"Invoice not found"});

    if (["Approved", "Rejected"].includes(invoice.status))
      return send(res, 409, {error:"Reopen invoice first"});

    const result = evaluate(invoice, invoices);

    invoice.issues = result.issues;
    invoice.automation = result;

    if (result.eligible) {
      invoice.status = "Approved";
      invoice.approvedBy = "Automation Engine";
      invoice.approvedAt = new Date().toISOString();
    } else {
      invoice.status = "Review Required";
      delete invoice.approvedBy;
      delete invoice.approvedAt;
    }

    write("invoices", invoices);

    const audit = read("audit", []);
    audit.unshift({
      id: require("crypto").randomUUID(),
      action: result.eligible ? "AUTO_APPROVED" : "AUTO_REVIEW_REQUIRED",
      invoiceId: invoice.id,
      details: result.reasons.join("; "),
      at: new Date().toISOString()
    });
    write("audit", audit);

    return send(res, 200, {
      invoice,
      evaluation: result
    });
  }

  return false;
}

module.exports = {handle};
