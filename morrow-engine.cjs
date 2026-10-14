
const fs=require("fs");
const path=require("path");
const crypto=require("crypto");
const pdfjs=require("pdfjs-dist/legacy/build/pdf.js");
const Tesseract=require("tesseract.js");
const dataDir=path.join(__dirname,"data");
const uploadDir=path.join(__dirname,"uploads");
const GL={
  Packaging:["6100","Packaging & Materials"],
  Logistics:["6200","Freight & Shipping"],
  Marketing:["6300","Advertising & Marketing"],
  Software:["6400","Software Subscriptions"],
  Manufacturing:["6500","Cost of Goods Sold"],
  "Professional Services":["6600","Professional Fees"],
  Other:["6900","Other Operating Expenses"]
};
function read(name,fallback=[]){
  try{return JSON.parse(fs.readFileSync(path.join(dataDir,name),"utf8"))}
  catch{return fallback}
}
function write(name,value){
  const dest=path.join(dataDir,name);
  const tmp=dest+".tmp";
  fs.writeFileSync(tmp,JSON.stringify(value,null,2));
  fs.renameSync(tmp,dest);
}
function send(res,status,value){
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});
  res.end(JSON.stringify(value));
}
async function body(req){
  const parts=[];let bytes=0;
  for await(const part of req){
    bytes+=part.length;
    if(bytes>15*1024*1024)throw Error("Upload exceeds request limit");
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}
function log(action,id,details=""){
  const rows=read("audit.json");
  rows.unshift({id:crypto.randomUUID(),invoiceId:id,action,details,timestamp:new Date().toISOString()});
  write("audit.json",rows);
}
function date(value){
  if(!value)return "";
  const match=String(value).match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if(match)return `${match[1]}-${match[2].padStart(2,"0")}-${match[3].padStart(2,"0")}`;
  const d=new Date(value);
  return Number.isNaN(d.getTime())?"":d.toISOString().slice(0,10);
}
function field(text,patterns){
  for(const p of patterns){const m=text.match(p);if(m)return m[1].trim()}
  return "";
}
function rules(text){
  const lines=text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const total=field(text,[
    /(?:grand total|amount due|total due|balance due)\s*[:$ ]*([\d,]+\.\d{2})/i,
    /\btotal\s*[:$ ]*([\d,]+\.\d{2})/i
  ]);
  return {
    supplier:lines.find(x=>/[a-z]/i.test(x)&&x.length<90&&!/^(invoice|date|total|due|bill to)/i.test(x))||"",
    number:field(text,[/invoice\s*(?:number|no\.?|#|id)\s*[:# -]*([a-z0-9/-]+)/i]),
    invoiceDate:date(field(text,[/(?:invoice date|date issued)\s*[: -]*([a-z0-9,./ -]{6,22})/i])),
    dueDate:date(field(text,[/(?:due date|payment due)\s*[: -]*([a-z0-9,./ -]{6,22})/i])),
    amount:Number(total.replace(/,/g,""))||0,
    currency:"USD",subtotal:null,tax:null,lineItems:[]
  };
}

async function ocr(buffer,mime){
  if(mime!=="application/pdf"){
    const result=await Tesseract.recognize(buffer,"eng");
    return {
      text:result.data.text,
      method:"Tesseract OCR",
      pages:1,
      confidence:result.data.confidence
    };
  }

  const document=await pdfjs.getDocument({
    data:new Uint8Array(buffer),
    useSystemFonts:true,
    disableFontFace:true
  }).promise;

  if(document.numPages>20){
    throw Error("Maximum 20 PDF pages");
  }

  const pages=[];
  let scannedPages=0;
  const {createCanvas}=require("@napi-rs/canvas");

  for(let i=1;i<=document.numPages;i++){
    const page=await document.getPage(i);
    const content=await page.getTextContent();
    const embedded=content.items.map(x=>x.str).join(" ");

    if(embedded.trim().length>=30){
      pages.push(embedded);
      continue;
    }

    const viewport=page.getViewport({scale:2});
    const canvas=createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height)
    );

    const context=canvas.getContext("2d");

    await page.render({
      canvasContext:context,
      viewport
    }).promise;

    const png=await canvas.encode("png");
    const result=await Tesseract.recognize(png,"eng");

    pages.push(result.data.text);
    scannedPages++;
  }

  return {
    text:pages.join("\n\n"),
    method:scannedPages
      ?"PDF OCR ("+scannedPages+" scanned pages)"
      :"PDF embedded text",
    pages:document.numPages,
    scannedPages
  };
}

async function vision(buffer,mime,text){
  const content=[{
    type:"input_text",
    text:"Extract invoice data as JSON with supplier, number, invoiceDate, dueDate, amount, currency, subtotal, tax, lineItems. Dates YYYY-MM-DD. Numeric amounts. Null when missing. Do not invent values. OCR text:\n"+text.slice(0,12000)
  }];
  if(mime==="application/pdf"){
    content.push({
      type:"input_file",
      filename:"invoice.pdf",
      file_data:"data:application/pdf;base64,"+buffer.toString("base64")
    });
  }else{
    content.push({
      type:"input_image",
      image_url:"data:"+mime+";base64,"+buffer.toString("base64")
    });
  }
  const response=await fetch("https://api.openai.com/v1/responses",{
    method:"POST",
    headers:{
      Authorization:"Bearer "+process.env.OPENAI_API_KEY,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      model:process.env.OPENAI_MODEL||"gpt-4.1-mini",
      input:[{role:"user",content}],
      text:{format:{type:"json_object"}}
    })
  });
  const result=await response.json();
  if(!response.ok)throw Error(result.error?.message||"Vision API failed");
  const output=(result.output||[]).flatMap(x=>x.content||[])
    .filter(x=>x.type==="output_text").map(x=>x.text).join("");
  return {fields:JSON.parse(output),usage:result.usage||{}};
}
function classify(fields,text){
  const source=(fields.supplier+" "+JSON.stringify(fields.lineItems||[])+" "+text).toLowerCase();
  const tests=[
    ["Packaging",/packag|carton|corrugated/],
    ["Logistics",/freight|shipping|warehouse|fulfill/],
    ["Marketing",/advertis|campaign|influencer/],
    ["Software",/software|subscription|hosting|license/],
    ["Manufacturing",/manufactur|production|inventory/],
    ["Professional Services",/consult|legal|accounting|advisory/]
  ];
  return tests.find(x=>x[1].test(source))?.[0]||"Other";
}
function validate(f,existing,id=null){
  const issues=[];
  if(!f.supplier)issues.push("Supplier missing");
  if(!f.number)issues.push("Invoice number missing");
  if(!f.invoiceDate)issues.push("Invoice date missing");
  if(!f.dueDate)issues.push("Due date missing");
  if(!(Number(f.amount)>0))issues.push("Invalid total");
  if(f.invoiceDate&&f.dueDate&&f.dueDate<f.invoiceDate)issues.push("Due date precedes invoice date");
  if(existing.some(x=>x.id!==id&&String(x.supplier).toLowerCase()===String(f.supplier).toLowerCase()&&String(x.number).toLowerCase()===String(f.number).toLowerCase()))
    issues.push("Possible duplicate");
  if(f.subtotal!=null&&f.tax!=null&&Math.abs(Number(f.subtotal)+Number(f.tax)-Number(f.amount))>.02)
    issues.push("Subtotal and tax mismatch");
  return issues;
}

const DEFAULT_RULES={
  autoApproveEnabled:true,
  autoApproveMaxAmount:500,
  blockDuplicates:true,
  requireCompleteFields:true,
  manualReviewCategories:["Professional Services"],
  approvalThreshold:2500
};

function getRules(){
  const stored=read("morrow-rules.json",{});
  return {...DEFAULT_RULES,...stored};
}

function saveRules(input){
  const next={...getRules()};

  for(const key of [
    "autoApproveEnabled",
    "blockDuplicates",
    "requireCompleteFields"
  ]){
    if(typeof input[key]==="boolean"){
      next[key]=input[key];
    }
  }

  for(const key of [
    "autoApproveMaxAmount",
    "approvalThreshold"
  ]){
    if(input[key]!==undefined){
      const value=Number(input[key]);
      if(!Number.isFinite(value)||value<0){
        throw Error("Invalid amount for "+key);
      }
      next[key]=value;
    }
  }

  if(Array.isArray(input.manualReviewCategories)){
    next.manualReviewCategories=input.manualReviewCategories
      .filter(x=>Object.hasOwn(GL,x));
  }

  write("morrow-rules.json",next);
  return next;
}

function evaluateApproval(invoice,rules=getRules()){
  const reasons=[];
  const issues=invoice.issues||[];
  const amount=Number(invoice.amount)||0;

  if(rules.blockDuplicates &&
    issues.some(x=>/duplicate/i.test(x))){
    reasons.push("Duplicate invoice requires review");
  }

  if(rules.requireCompleteFields &&
    issues.some(x=>/missing|invalid|precedes|mismatch/i.test(x))){
    reasons.push("Invoice validation failed");
  }

  if(rules.manualReviewCategories.includes(invoice.glCategory)){
    reasons.push("GL category requires manual approval");
  }

  if(amount>rules.approvalThreshold){
    reasons.push("High-value invoice requires senior approval");
  }

  if(!rules.autoApproveEnabled){
    reasons.push("Automatic approval is disabled");
  }else if(amount>rules.autoApproveMaxAmount){
    reasons.push("Amount exceeds automatic approval limit");
  }

  return {
    eligible:reasons.length===0,
    reasons,
    evaluatedAt:new Date().toISOString()
  };
}

async function handle(req,res,url){
  const p=url.pathname;

  if(p==="/api/morrow/rules"&&req.method==="GET"){
    return send(res,200,getRules());
  }

  if(p==="/api/morrow/rules"&&req.method==="PATCH"){
    const input=await body(req);
    const rules=saveRules(input);
    log("AUTOMATION_RULES_UPDATED",null,JSON.stringify(rules));
    return send(res,200,rules);
  }

  if(p==="/api/morrow/automation/evaluate"&&req.method==="POST"){
    const input=await body(req);
    const invoice=read("invoices.json")
      .find(x=>x.id===input.invoiceId);

    if(!invoice){
      return send(res,404,{error:"Invoice not found"});
    }

    return send(res,200,evaluateApproval(invoice));
  }

  if(p==="/api/morrow/automation/apply"&&req.method==="POST"){
    const input=await body(req);
    const invoices=read("invoices.json");
    const invoice=invoices.find(x=>x.id===input.invoiceId);

    if(!invoice){
      return send(res,404,{error:"Invoice not found"});
    }

    if(["Approved","Rejected"].includes(invoice.status)){
      return send(res,409,{
        error:"Finalized invoices cannot be automatically changed"
      });
    }

    const evaluation=evaluateApproval(invoice);

    invoice.automation=evaluation;

    if(evaluation.eligible){
      invoice.status="Approved";
      invoice.approvedBy="Automation Engine";
      invoice.approvedAt=new Date().toISOString();
      log("AUTO_APPROVED",invoice.id,"Rule engine");
    }else{
      invoice.status="Review Required";
      log(
        "MANUAL_REVIEW_REQUIRED",
        invoice.id,
        evaluation.reasons.join("; ")
      );
    }

    write("invoices.json",invoices);

    return send(res,200,{invoice,evaluation});
  }

  if(p==="/api/morrow/config"&&req.method==="GET")
    return send(res,200,{aiConfigured:!!process.env.OPENAI_API_KEY,model:process.env.OPENAI_MODEL||"gpt-4.1-mini"});
  if(p==="/api/morrow/gl"&&req.method==="GET")return send(res,200,GL);
  if(p==="/api/morrow/process"&&req.method==="POST"){
    const input=await body(req);
    if(!["application/pdf","image/png","image/jpeg"].includes(input.mime))
      return send(res,400,{error:"Only PDF, PNG and JPEG supported"});
    if(!["ocr","hybrid"].includes(input.mode))
      return send(res,400,{error:"Invalid processing mode"});
    if(input.mode==="hybrid"&&!process.env.OPENAI_API_KEY)
      return send(res,400,{error:"Set OPENAI_API_KEY in .env before using Hybrid"});
    if(typeof input.base64!=="string"||!/^[a-z0-9+/]*={0,2}$/i.test(input.base64))
      return send(res,400,{error:"Invalid document encoding"});
    const buffer=Buffer.from(input.base64,"base64");
    if(!buffer.length||buffer.length>10*1024*1024)
      return send(res,400,{error:"Maximum file size 10 MB"});
    const started=Date.now();
    const extracted=await ocr(buffer,input.mime);
    const ai=input.mode==="hybrid"?await vision(buffer,input.mime,extracted.text):null;
    const f=rules(extracted.text);
    if(ai)for(const [k,v] of Object.entries(ai.fields))
      if(v!==null&&v!==undefined&&v!=="")f[k]=v;
    f.invoiceDate=date(f.invoiceDate);
    f.dueDate=date(f.dueDate);
    f.amount=Number(f.amount)||0;
    const invoices=read("invoices.json");
    const category=classify(f,extracted.text);
    const issues=validate(f,invoices);
    const id=crypto.randomUUID();
    const ext=input.mime==="application/pdf"?"pdf":input.mime==="image/png"?"png":"jpg";
    const filename=id+"."+ext;
    fs.writeFileSync(path.join(uploadDir,filename),buffer);
    const invoice={
      id,supplier:f.supplier||"",number:f.number||"",
      invoiceDate:f.invoiceDate||"",dueDate:f.dueDate||"",
      amount:f.amount,currency:f.currency||"USD",
      subtotal:f.subtotal??null,tax:f.tax??null,
      lineItems:f.lineItems||[],glCategory:category,
      glCode:GL[category][0],status:"Review Required",
      source:ai?"Vision LLM":"OCR",filename:input.name||filename,
      documentFile:filename,documentMime:input.mime,
      issues,createdAt:new Date().toISOString(),
      extraction:{
        ocrText:extracted.text,ocrMethod:extracted.method,
        ocrConfidence:extracted.confidence??null,
        method:ai?"Hybrid OCR + Vision":"OCR / PDF text"
      }
    };
    const evaluation=evaluateApproval(invoice);
    invoice.automation=evaluation;

    if(evaluation.eligible){
      invoice.status="Approved";
      invoice.approvedBy="Automation Engine";
      invoice.approvedAt=new Date().toISOString();
    }else{
      invoice.status="Review Required";
    }

    invoices.unshift(invoice);
    write("invoices.json",invoices);

    log(
      evaluation.eligible?"AUTO_APPROVED":"MANUAL_REVIEW_REQUIRED",
      id,
      evaluation.reasons.join("; ")
    );
    const benchmarks=read("benchmark.json");
    benchmarks.unshift({
      id:crypto.randomUUID(),invoiceId:id,
      model:ai?(process.env.OPENAI_MODEL||"gpt-4.1-mini"):"Tesseract / PDF.js",
      latencyMs:Date.now()-started,
      inputTokens:ai?.usage?.input_tokens??null,
      outputTokens:ai?.usage?.output_tokens??null,
      timestamp:new Date().toISOString()
    });
    write("benchmark.json",benchmarks);
    log("DOCUMENT_PROCESSED",id,invoice.extraction.method);
    return send(res,201,{invoice});
  }
  const doc=p.match(/^\/api\/morrow\/document\/([a-f0-9-]+)$/);
  if(doc&&req.method==="GET"){
    const invoice=read("invoices.json").find(x=>x.id===doc[1]);
    if(!invoice?.documentFile)return send(res,404,{error:"Document not found"});
    const file=path.join(uploadDir,path.basename(invoice.documentFile));
    if(!fs.existsSync(file))return send(res,404,{error:"File missing"});
    res.writeHead(200,{
      "Content-Type":invoice.documentMime||"application/octet-stream",
      "Content-Disposition":"inline",
      "X-Content-Type-Options":"nosniff"
    });
    fs.createReadStream(file).pipe(res);
    return true;
  }
  const gl=p.match(/^\/api\/morrow\/invoice\/([a-f0-9-]+)\/gl$/);
  if(gl&&req.method==="PATCH"){
    const input=await body(req);
    const invoices=read("invoices.json");
    const invoice=invoices.find(x=>x.id===gl[1]);
    if(!invoice)return send(res,404,{error:"Invoice not found"});
    if(invoice.status==="Approved")return send(res,409,{error:"Approved invoice locked"});
    if(!GL[input.category])return send(res,400,{error:"Invalid GL category"});
    invoice.glCategory=input.category;
    invoice.glCode=GL[input.category][0];
    write("invoices.json",invoices);
    log("GL_UPDATED",invoice.id,input.category);
    return send(res,200,invoice);
  }
  if(p==="/api/morrow/journal"&&req.method==="GET"){
    const rows=read("invoices.json").filter(x=>x.status==="Approved").flatMap(x=>{
      const gl=GL[x.glCategory]||GL.Other;
      return [
        {invoice:x.number,supplier:x.supplier,date:x.invoiceDate,account:gl[0],accountName:gl[1],debit:Number(x.amount)||0,credit:0},
        {invoice:x.number,supplier:x.supplier,date:x.invoiceDate,account:"2000",accountName:"Accounts Payable",debit:0,credit:Number(x.amount)||0}
      ];
    });
    return send(res,200,rows);
  }
  return false;
}
module.exports={handle};
