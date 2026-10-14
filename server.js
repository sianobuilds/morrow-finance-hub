const financeAddon = require('./finance-addon.cjs');
const morrowEngine = require("./morrow-engine.cjs");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = 3067;
const ROOT = __dirname;
const DATA = path.join(ROOT, "data");
const DB = path.join(DATA, "invoices.json");
const LOGS = path.join(DATA, "audit.json");
const BENCH = path.join(DATA, "benchmark.json");

fs.mkdirSync(DATA, { recursive: true });

const demo = [
  ["Northline Supply","INV-2026-1042",4850,"Approved"],
  ["Evergreen Packaging","EP-2026-0891",2140,"Review Required"],
  ["Atlas Logistics","ATL-2026-3220",6720,"Processing"],
  ["Hearthstone Manufacturing","HM-24018",12850,"Approved"],
  ["Studio North Creative","SN-2026-118",3750,"Ready for Approval"],
  ["Pacific Freight Co.","PF-2026-450",9180,"Approved"],
  ["Bloom Packaging","BP-26012",1640,"Review Required"],
  ["Cedar Textile Works","CT-2026-84",7230,"Approved"],
  ["Brightline Digital","BD-1048",2800,"Ready for Approval"],
  ["Westport Fulfillment","WF-2206",5420,"Approved"],
  ["Lumen Design Studio","LD-1802",1950,"Review Required"],
  ["Meridian Imports","MI-2026-77",11240,"Approved"]
];

if (!fs.existsSync(DB)) {
  fs.writeFileSync(DB, JSON.stringify(demo.map((d,i)=>({
    id: crypto.randomUUID(),
    supplier:d[0],number:d[1],amount:d[2],status:d[3],
    currency:"USD",invoiceDate:"2026-10-01",
    dueDate:"2026-10-30",source:"Demo",
    filename:"",extraction:null,
    createdAt:new Date().toISOString()
  })),null,2));
}
if (!fs.existsSync(LOGS)) fs.writeFileSync(LOGS,"[]");
if (!fs.existsSync(BENCH)) fs.writeFileSync(BENCH,"[]");

const read = p => JSON.parse(fs.readFileSync(p,"utf8"));
const write = (p,v) => fs.writeFileSync(p,JSON.stringify(v,null,2));

function respond(res,code,data){
  res.writeHead(code,{
    "Content-Type":"application/json; charset=utf-8",
    "Access-Control-Allow-Origin":"http://localhost:3067"
  });
  res.end(JSON.stringify(data));
}

function audit(invoiceId,action){
  const logs=read(LOGS);
  logs.unshift({
    id:crypto.randomUUID(),invoiceId,action,
    timestamp:new Date().toISOString()
  });
  write(LOGS,logs);
}

function body(req,limit=15000000){
  return new Promise((resolve,reject)=>{
    let chunks=[],size=0;
    req.on("data",chunk=>{
      size+=chunk.length;
      if(size>limit){
        reject(new Error("File exceeds size limit"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end",()=>{
      try {resolve(JSON.parse(Buffer.concat(chunks).toString()));}
      catch {reject(new Error("Invalid JSON"));}
    });
    req.on("error",reject);
  });
}

function validDate(v){
  return !v || /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function validate(inv,others){
  const issues=[];
  if(!inv.supplier || inv.supplier==="Unknown")
    issues.push("Supplier requires review");
  if(!inv.number || inv.number==="Unknown")
    issues.push("Invoice number requires review");
  if(!Number.isFinite(Number(inv.amount)) || Number(inv.amount)<=0)
    issues.push("Amount must be greater than zero");
  if(!validDate(inv.invoiceDate)||!validDate(inv.dueDate))
    issues.push("Invalid date format");
  if(inv.invoiceDate && inv.dueDate &&
     inv.dueDate<inv.invoiceDate)
    issues.push("Due date precedes invoice date");
  if(others.some(x=>
    x.id!==inv.id &&
    x.supplier.toLowerCase()===inv.supplier.toLowerCase() &&
    x.number.toLowerCase()===inv.number.toLowerCase()
  )) issues.push("Possible duplicate invoice");
  return issues;
}

async function extractWithAI(payload){
  const key=process.env.OPENAI_API_KEY;
  if(!key) throw new Error(
    "OPENAI_API_KEY is not configured. Add it to .env."
  );

  const {name,mime,base64}=payload;
  if(!["application/pdf","image/png","image/jpeg"].includes(mime))
    throw new Error("Supported files: PDF, PNG, JPG");
  if(!base64 || Buffer.byteLength(base64,"base64")>10*1024*1024)
    throw new Error("Maximum file size is 10 MB");

  const filePart=mime==="application/pdf"
    ? {type:"input_file",filename:name||"invoice.pdf",
       file_data:`data:${mime};base64,${base64}`}
    : {type:"input_image",
       image_url:`data:${mime};base64,${base64}`};

  const started=Date.now();
  const response=await fetch("https://api.openai.com/v1/responses",{
    method:"POST",
    headers:{
      Authorization:`Bearer ${key}`,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      model:"gpt-4.1-mini",
      input:[{
        role:"user",
        content:[
          {type:"input_text",text:
            "You are an invoice extraction engine. " +
            "Extract ONLY values visible in the document. " +
            "Return a JSON object with these keys: " +
            "supplier, number, invoiceDate, dueDate, " +
            "amount, currency, subtotal, tax, " +
            "lineItems, confidenceNotes. " +
            "Dates must be YYYY-MM-DD. " +
            "amount, subtotal, tax must be numbers or null. " +
            "lineItems is an array of objects with " +
            "description, quantity, unitPrice, total. " +
            "Use null when unknown. Do not invent data."},
          filePart
        ]
      }],
      text:{format:{type:"json_object"}}
    })
  });

  const result=await response.json();
  if(!response.ok)
    throw new Error(result.error?.message||"AI request failed");

  const output=(result.output||[])
    .flatMap(x=>x.content||[])
    .filter(x=>x.type==="output_text")
    .map(x=>x.text).join("");

  if(!output) throw new Error("AI returned no extraction text");

  const parsed=JSON.parse(output);
  const elapsed=Date.now()-started;

  const runs=read(BENCH);
  runs.unshift({
    id:crypto.randomUUID(),
    method:"Vision LLM",
    model:"gpt-4.1-mini",
    latencyMs:elapsed,
    inputTokens:result.usage?.input_tokens??null,
    outputTokens:result.usage?.output_tokens??null,
    timestamp:new Date().toISOString()
  });
  write(BENCH,runs);

  return {parsed,elapsed};
}

const server=http.createServer(async(req,res)=>{
  // FINANCE_ADDON_ROUTER_V3
  try {
    const financeURL = new URL(req.url, "http://localhost");
    if (
      financeURL.pathname === "/finance-operations" ||
      financeURL.pathname === "/api/health" ||
      financeURL.pathname === "/api/gl" ||
      financeURL.pathname === "/api/suppliers" ||
      financeURL.pathname.startsWith("/api/suppliers/") ||
      financeURL.pathname === "/api/rules" ||
      financeURL.pathname === "/api/journal" ||
      financeURL.pathname.startsWith("/api/automation/")
    ) {
      await financeAddon.handle(req,res,financeURL);
      return;
    }
  } catch (error) {
    console.error("Finance addon error:",error);
    if (!res.headersSent) {
      res.writeHead(500,{"Content-Type":"application/json"});
      res.end(JSON.stringify({error:error.message}));
    } else {
      res.end();
    }
    return;
  }

  // MORROW_ENGINE_ROUTER_V2
  try {
    const morrowUrl = new URL(req.url, "http://localhost");
    if (morrowUrl.pathname === "/morrow-ui.js") {
      res.writeHead(200, {"Content-Type":"application/javascript; charset=utf-8"});
      require("fs").createReadStream(
        require("path").join(__dirname,"morrow-ui.js")
      ).pipe(res);
      return;
    }
    if (morrowUrl.pathname.startsWith("/api/morrow/")) {
      await morrowEngine.handle(req,res,morrowUrl);
      return;
    }
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, {"Content-Type":"application/json"});
      res.end(JSON.stringify({error:error.message}));
    } else {
      res.end();
    }
    return;
  }

  const url=new URL(req.url,`http://localhost:${PORT}`);

  try {
    if(req.method==="GET" && url.pathname==="/"){
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
      return res.end(fs.readFileSync(path.join(ROOT,"index.html")));
    }

    if(req.method==="GET" && url.pathname==="/api/invoices")
      return respond(res,200,read(DB));

    if(req.method==="GET" && url.pathname==="/api/audit")
      return respond(res,200,read(LOGS));

    if(req.method==="GET" && url.pathname==="/api/benchmark")
      return respond(res,200,read(BENCH));

    if(req.method==="GET" && url.pathname==="/api/config")
      return respond(res,200,{
        aiConfigured:!!process.env.OPENAI_API_KEY,
        model:"gpt-4.1-mini",
        provider:"OpenAI"
      });

    if(req.method==="POST" && url.pathname==="/api/extract"){
      const input=await body(req);
      const {parsed,elapsed}=await extractWithAI(input);
      const invoices=read(DB);
      const invoice={
        id:crypto.randomUUID(),
        supplier:String(parsed.supplier||"Unknown"),
        number:String(parsed.number||"Unknown"),
        invoiceDate:String(parsed.invoiceDate||""),
        dueDate:String(parsed.dueDate||""),
        amount:Number(parsed.amount)||0,
        currency:String(parsed.currency||"USD"),
        status:"Review Required",
        source:"Vision LLM",
        filename:String(input.name||"invoice").slice(0,150),
        extraction:parsed,
        createdAt:new Date().toISOString()
      };
      invoice.issues=validate(invoice,invoices);
      invoices.unshift(invoice);
      write(DB,invoices);
      audit(invoice.id,"AI extraction completed");
      return respond(res,200,{invoice,elapsed});
    }

    if(req.method==="PATCH" && url.pathname.startsWith("/api/invoices/")){
      const id=url.pathname.split("/")[3];
      const changes=await body(req,100000);
      const invoices=read(DB);
      const invoice=invoices.find(x=>x.id===id);
      if(!invoice) return respond(res,404,{error:"Invoice not found"});
      if(invoice.status==="Approved")
        return respond(res,409,{error:"Approved invoice is locked"});
      for(const field of [
        "supplier","number","invoiceDate","dueDate","currency"
      ]){
        if(changes[field]!==undefined)
          invoice[field]=String(changes[field]).slice(0,200);
      }
      if(changes.amount!==undefined)
        invoice.amount=Number(changes.amount);
      invoice.issues=validate(invoice,invoices);
      write(DB,invoices);
      audit(id,"Invoice fields updated");
      return respond(res,200,invoice);
    }

    if(req.method==="POST" && url.pathname.startsWith("/api/workflow/")){
      const id=url.pathname.split("/")[3];
      const {action}=await body(req,10000);
      const invoices=read(DB);
      const invoice=invoices.find(x=>x.id===id);
      if(!invoice) return respond(res,404,{error:"Invoice not found"});

      const transitions={
        submit:["Review Required","Ready for Approval"],
        approve:["Ready for Approval","Approved"],
        reject:["Ready for Approval","Rejected"],
        reopen:["Rejected","Review Required"]
      };
      const t=transitions[action];
      if(!t||invoice.status!==t[0])
        return respond(res,409,{error:"Invalid status transition"});

      if(action==="submit"){
        invoice.issues=validate(invoice,invoices);
        if(invoice.issues.length)
          return respond(res,422,{error:invoice.issues.join("; ")});
      }
      invoice.status=t[1];
      write(DB,invoices);
      audit(id,`Invoice ${action}`);
      return respond(res,200,invoice);
    }

    return respond(res,404,{error:"Not found"});
  } catch(e){
    console.error(e);
    return respond(res,500,{error:e.message||"Server error"});
  }
});

server.listen(PORT,"127.0.0.1",()=>{
  console.log(`Morrow Finance Hub: http://localhost:${PORT}`);
});
