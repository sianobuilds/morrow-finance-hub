
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA = path.join(__dirname, "data");
fs.mkdirSync(DATA, {recursive:true});

const GL = {
  Packaging:["6100","Packaging & Materials"],
  Logistics:["6200","Freight & Shipping"],
  Marketing:["6300","Advertising & Marketing"],
  Software:["6400","Software Subscriptions"],
  Manufacturing:["6500","Cost of Goods Sold"],
  "Professional Services":["6600","Professional Fees"],
  Other:["6900","Other Operating Expenses"]
};

const DEFAULT_RULES = {
  autoApprove:false,
  autoApproveMax:500,
  seniorThreshold:2500,
  blockDuplicates:true,
  requireValid:true,
  manualCategories:["Professional Services"]
};

function read(name, fallback) {
  try {
    const value = JSON.parse(
      fs.readFileSync(path.join(DATA,name+".json"),"utf8")
    );
    return value;
  } catch {
    return fallback;
  }
}

function save(name,value) {
  const file = path.join(DATA,name+".json");
  const tmp = file+".tmp";
  fs.writeFileSync(tmp,JSON.stringify(value,null,2));
  fs.renameSync(tmp,file);
}

function respond(res,status,value) {
  res.writeHead(status,{
    "Content-Type":"application/json; charset=utf-8",
    "Cache-Control":"no-store"
  });
  res.end(JSON.stringify(value));
}

async function parse(req) {
  const chunks=[];
  let length=0;
  for await (const chunk of req) {
    length+=chunk.length;
    if(length>1024*1024) throw Error("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString()||"{}");
}

function audit(action,id,details) {
  const events=read("audit",[]);
  events.unshift({
    id:crypto.randomUUID(),
    action,
    invoiceId:id,
    details,
    timestamp:new Date().toISOString()
  });
  save("audit",events);
}

function rules() {
  return {...DEFAULT_RULES,...read("morrow-rules",{})};
}

function evaluate(invoice, all) {
  const r=rules();
  const reasons=[];
  const amount=Number(invoice.amount)||0;
  const issues=Array.isArray(invoice.issues)?invoice.issues:[];

  const duplicate=all.some(other=>
    other.id!==invoice.id &&
    String(other.supplier||"").trim().toLowerCase()===
      String(invoice.supplier||"").trim().toLowerCase() &&
    String(other.number||"").trim().toLowerCase()===
      String(invoice.number||"").trim().toLowerCase() &&
    Boolean(invoice.number)
  );

  if(r.blockDuplicates && duplicate)
    reasons.push("Duplicate invoice");

  if(r.requireValid) {
    if(!invoice.supplier || !invoice.number ||
       !invoice.invoiceDate || !invoice.dueDate || amount<=0)
      reasons.push("Missing or invalid invoice fields");
    if(issues.some(x=>/missing|invalid|mismatch|precedes/i.test(x)))
      reasons.push("Existing validation issues");
  }

  if(r.manualCategories.includes(invoice.glCategory))
    reasons.push("Manual review GL category");

  if(amount>r.seniorThreshold)
    reasons.push("Senior approval required");

  if(!r.autoApprove)
    reasons.push("Automatic approval disabled");
  else if(amount>r.autoApproveMax)
    reasons.push("Above automatic approval limit");

  return {
    eligible:reasons.length===0,
    reasons:[...new Set(reasons)]
  };
}

async function handle(req,res,url) {
  const p=url.pathname;
  const method=req.method;

  if(p==="/api/health" && method==="GET")
    return respond(res,200,{ok:true,port:3067,extension:"finance-v3"});

  if(p==="/api/gl" && method==="GET")
    return respond(res,200,GL);

  if(p==="/api/suppliers" && method==="GET")
    return respond(res,200,read("suppliers",[]));

  if(p==="/api/suppliers" && method==="POST") {
    const input=await parse(req);
    const name=String(input.name||"").trim();
    if(!name)return respond(res,400,{error:"Supplier name required"});

    const suppliers=read("suppliers",[]);
    if(suppliers.some(x=>x.name.toLowerCase()===name.toLowerCase()))
      return respond(res,409,{error:"Supplier already exists"});

    const supplier={
      id:crypto.randomUUID(),
      name,
      email:String(input.email||"").trim(),
      category:String(input.category||"Other"),
      paymentTerms:String(input.paymentTerms||"Net 30")
    };
    suppliers.unshift(supplier);
    save("suppliers",suppliers);
    audit("SUPPLIER_CREATED",supplier.id,name);
    return respond(res,201,supplier);
  }

  const supplierRoute=p.match(/^\/api\/suppliers\/([a-f0-9-]+)$/);
  if(supplierRoute && ["PATCH","DELETE"].includes(method)) {
    const suppliers=read("suppliers",[]);
    const index=suppliers.findIndex(x=>x.id===supplierRoute[1]);
    if(index<0)return respond(res,404,{error:"Supplier not found"});

    if(method==="DELETE") {
      const old=suppliers.splice(index,1)[0];
      save("suppliers",suppliers);
      audit("SUPPLIER_DELETED",old.id,old.name);
      return respond(res,200,{ok:true});
    }

    const input=await parse(req);
    const updated={...suppliers[index]};
    for(const field of ["name","email","category","paymentTerms"])
      if(input[field]!==undefined)
        updated[field]=String(input[field]).trim();

    if(!updated.name)
      return respond(res,400,{error:"Supplier name required"});

    if(suppliers.some(x=>x.id!==updated.id &&
      x.name.toLowerCase()===updated.name.toLowerCase()))
      return respond(res,409,{error:"Supplier name already exists"});

    suppliers[index]=updated;
    save("suppliers",suppliers);
    audit("SUPPLIER_UPDATED",updated.id,updated.name);
    return respond(res,200,updated);
  }

  if(p==="/api/rules" && method==="GET")
    return respond(res,200,rules());

  if(p==="/api/rules" && method==="PATCH") {
    const input=await parse(req);
    const updated=rules();

    for(const field of ["autoApprove","blockDuplicates","requireValid"])
      if(typeof input[field]==="boolean")
        updated[field]=input[field];

    for(const field of ["autoApproveMax","seniorThreshold"]) {
      if(input[field]!==undefined) {
        const n=Number(input[field]);
        if(!Number.isFinite(n)||n<0)
          return respond(res,400,{error:"Invalid "+field});
        updated[field]=n;
      }
    }

    if(Array.isArray(input.manualCategories))
      updated.manualCategories=input.manualCategories.filter(x=>GL[x]);

    save("morrow-rules",updated);
    audit("RULES_UPDATED",null,"Approval configuration");
    return respond(res,200,updated);
  }

  if(p==="/api/automation/evaluate" && method==="POST") {
    const input=await parse(req);
    const invoices=read("invoices",[]);
    const invoice=invoices.find(x=>x.id===input.invoiceId);
    if(!invoice)return respond(res,404,{error:"Invoice not found"});
    return respond(res,200,evaluate(invoice,invoices));
  }

  if(p==="/api/automation/apply" && method==="POST") {
    const input=await parse(req);
    const invoices=read("invoices",[]);
    const invoice=invoices.find(x=>x.id===input.invoiceId);
    if(!invoice)return respond(res,404,{error:"Invoice not found"});
    if(["Approved","Rejected"].includes(invoice.status))
      return respond(res,409,{error:"Reopen finalized invoice first"});

    const result=evaluate(invoice,invoices);
    invoice.automation=result;
    invoice.status=result.eligible?"Approved":"Review Required";

    if(result.eligible) {
      invoice.approvedBy="Automation Engine";
      invoice.approvedAt=new Date().toISOString();
    }

    save("invoices",invoices);
    audit(
      result.eligible?"AUTO_APPROVED":"MANUAL_REVIEW_REQUIRED",
      invoice.id,
      result.reasons.join("; ")
    );
    return respond(res,200,{invoice,evaluation:result});
  }

  if(p==="/api/journal" && method==="GET") {
    const rows=read("invoices",[])
      .filter(x=>x.status==="Approved")
      .flatMap(x=>{
        const gl=GL[x.glCategory]||GL.Other;
        const amount=Number(x.amount)||0;
        return [
          {
            invoice:x.number||"",
            supplier:x.supplier||"",
            date:x.invoiceDate||"",
            account:gl[0],
            accountName:gl[1],
            debit:amount,
            credit:0
          },
          {
            invoice:x.number||"",
            supplier:x.supplier||"",
            date:x.invoiceDate||"",
            account:"2000",
            accountName:"Accounts Payable",
            debit:0,
            credit:amount
          }
        ];
      });
    return respond(res,200,rows);
  }

  if(p==="/finance-operations" && method==="GET") {
    const file=path.join(__dirname,"finance-operations.html");
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
    fs.createReadStream(file).pipe(res);
    return true;
  }

  return false;
}

module.exports={handle};
