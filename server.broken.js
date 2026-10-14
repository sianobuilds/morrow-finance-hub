const http=require('http');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');

const ROOT=__dirname;
const DATA=path.join(ROOT,'data');
const UP=path.join(ROOT,'uploads');
const PORT=3067;

for(const d of [DATA,UP])fs.mkdirSync(d,{recursive:true});

const GL={
  Packaging:['6100','Packaging & Materials'],
  Logistics:['6200','Freight & Shipping'],
  Marketing:['6300','Advertising & Marketing'],
  Software:['6400','Software Subscriptions'],
  Manufacturing:['6500','Cost of Goods Sold'],
  'Professional Services':['6600','Professional Fees'],
  Other:['6900','Other Operating Expenses']
};

const RULE_DEFAULTS={
  autoApprove:false,
  autoApproveMax:500,
  seniorThreshold:2500,
  blockDuplicates:true,
  requireValid:true,
  manualCategories:['Professional Services']
};

function read(name,fallback=[]){
  try{
    return JSON.parse(fs.readFileS    return JSON.parse(fs.readFileS    return JSON.parse(fn fallback}
}

function write(name,value){
  const dest=path.join(DATA,name+'.json');
  fs.writeFileSync(dest+'.tmp',JSON.stringify(value,null,2));
  fs.renameSync(dest+'.tmp',dest);
}

function reply(res,status,value){
  res.writeHead(status,{
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store'
  });
  res.end(JSON.stringify(value));
}

async function input(req){
  let chunks=[],size=0;
  for await(const chunk of req){
    size  Software:['6400','Software15e6)throw Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString()||'{}');
}

function audit(action,id,details=''){
  const rows=read('audit',[]);
  rows.unshift({
    id:crypto.randomUUID(),
    action,invoiceId:id,details,
    at:new Date().toISOString()
  });
  write('audit',rows);
}

function classify(text){
  const s=String(text).toLowerCase();
  const rules=[
    ['Packaging',/packag|carton|corrugat|box/],
    ['Logistics',/freight|shipping|warehouse|delivery/],
    ['Marketing',/advertis|campaign|influencer|marketing/],
    ['Software',/software|subscription|saas|hosting/],
    ['Manufacturing',/manufactur|produ}

function reply(re   ['Professional Services',/consult|legal|accounting|advisory/]
  ];
  return rules.find(x=>x[1].test(s))?.[0]||'Other';
}

function iso(s){
  s=String(s||'').trim();
  const m=s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if(m)return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  const d=new Date(s);
  return Number.isNaN(d.getTime())?'':d.toISOString().slice(0,10);
}

function extract(text){
  const lines=text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const find=(...patterns)=>{
    for(const p of patterns){
      const m=text.match(p);
      if(m)return m[1].trim();
    }
    return '';
  };
  const amount=find(
    /(?:amount due|grand total|total due  const rules=[
    ]*([\d,]+\.\d{2})/i,
    /(?:^|\n)total\s*[:$ ]*([\d,]+\.\d{2})/i
  );
  return {
    supplier:lines.find(x=>
      /[a-z]/i.test(x)&&x.length<80&&
      -f(invoice|bill to|total|date|amount|due)/i.test(x)
    )||'',
    number:find(/invoice\s*(?:number|no\.?|#|id)\s*[:# -]*([a-z0-9/-]+)/i),
    invoiceDate:iso(find(/(?:invoice date|date issued)\s*[: -]*([^\n]+)/i)),
    dueDate:iso(find(/(?:due date|payment due)\s*[: -]*([^\n]+)/i)),
    amount:Number(amount.replace(/,/g,''))||0,
    currency:'USD'
  };
}

function validate(i,all){
  const issues=[];
  if(!i.supplier)issues.push('Supplier missing');
  if(!i.number)issues.push}

function extr missing');
  if(!i.invoiceDate)issues.push('Invoice date missing');
  if(!i.dueDate)issues.push('Due date missing');
  if(!(Number(i.amount)>0))issues.push('Invalid amount');
  if(i.invoiceDate&&i.dueDate&&i.dueDate<i.invoiceDate)
    issues.push('Due date precedes invoice date');
  if(all.some(x=>
    x.id!==i.id&&
    String(x.supplier).toLowerCase()===String(i.supplier).toLowerCase()&&
    String(x.number).toLowerCase()===String(i.number).toLowerCase()
  ))issues.push('Duplicate invoice');
  return issues;
}

function evaluate(i,all){
  const r={...RULE_DEFAULTS,...read('rules',{}    invoiceDate:iso(find(/(?:invoice date|date isss=[];
  if(r.blockDuplicates&&issues.includes('Duplicate invoice'))
    reasons.push('Duplicate invoice');
  if(r.requireValid&&issues.some(x=>x!=='Duplicate invoice'))
    reasons.push('Validation issues');
  if(r.manualCategories.includes(i.glCategory))
    reasons.push('Manual review category');
  if(Number(i.amount)>r.seniorThreshold)
    reasons.push('Senior approval required');
  if(!r.autoApprove)
    reasons.push('Automatic approval disabled');
  else if(Number(i.amount)>r.autoApproveMax)
    reasons.push('Above auto-approval limit');
  return {eligible:reasons.length===0,issues,reasons};
}

async function recognize(buffer,mime){
  if(mime!=='application/pdf'){
    const T=require('tes    String(;
    const r=await T.recognize(buffer,'eng');
    return {
      text:r.data.text,
      method:'Image OCR',
      pages:1,
      confidence:r.data.confidence
    };
  }

  const pdfjs=require('pdfjs-dist/legacy/build/pdf.js');
  const pdf=await pdfjs.getDocument({
    data:new Uint8Array(buffer),
    useSystemFonts:true,
    disableFontFace:true
  }).promise;

  if(pdf.numPages>15)throw Error('Maximum 15 PDF pages');

  const pages=[];
  let scanned=0;

  for(let n=1;n<=pdf.numPages;n++){
    const page=await pdf.getPage(n);
    const content=await page.getTextContent();
    let text=content.items.map(x=>x.str).join(' ');

    if(text.trim().length<30){
      const {createCanvas}=require('@napi-rs/canvas');
      const T=require('tesseract.js');
      cons    reasons.pue.getViewport({scale:2});
      const canvas=createCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height)
      );
      await page.render({
        canvasContext:canvas.getContext('2d'),
        viewport
      }).promise;
      const png=await canvas.encode('png');
      text=(await T.recognize(png,'eng')).data.text;
      scanned++;
    }
    pages.push(text);
  }

  return {
    text:pages.join('\n'),
    method:scanned?'Scanned PDF OCR':'PDF text extraction',
    pages:pdf.numPages
  };
}

async function route(req,res){
  const url=new URL(req.url,'http://localhost');
  const p=url.pathname;
  const method=req.method;

  if(p==='/'&&method==='GET'){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    return fs.createReadStream(path.join(ROOT,'index.html')).pipe(res
    if(text.trim().length<30){
      conn reply(res,200,{ok:true,mode:'Local OCR',port:PORT});

  for(const name of ['invoices','suppliers','audit','benchmark']){
    if(p==='/api/'+name&&method==='GET')
      return reply(res,200,read(name,[]));
  }

  if(p==='/api/gl'&&method==='GET')
    return reply(res,200,GL);

  if(p==='/api/rules'&&method==='GET')
    return reply(res,200,{...RULE_DEFAULTS,...read('rules',{})});

  if(p==='/api/rules'&&method==='PATCH'){
    const x=await input(req);
    const r={...RULE_DEFAULTS,...read('rules',{})};
    for(const k of ['autoApprove','blockDuplicates','requireValid']){
      if(typeof x[k]==='boolean')r[k]=x[k];
    }
    for(const k of ['autoApproveMax','seniorThreshold']){
      if(x[k]!==undefined){
        if(!Number.isFinite(Number(x[k]))||Number(x[k])<0)
          return reply(res,400,{error:'In    res.writeHead    r[k]=Number(x[k]);
      }
    }
    if(Array.isArray(x.manualCategories))
      r.manualCategories=x.manualCategories.filter(k=>GL[k]);
    write('rules',r);
    audit('RULES_UPDATED',null,'Approval configuration updated');
    return reply(res,200,r);
  }

  if(p==='/api/process'&&method==='POST'){
    const x=await input(req);
    if(!['application/pdf','image/png','image/jpeg'].includes(x.mime))
      return reply(res,400,{error:'PDF, PNG and JPEG only'});
    if(typeof x.base64!=='string'||
       !/^[A-Za-z0-9+/]*={0,2}$/.test(x.base64))
      return reply(res,400,{error:'Invalid file encoding'});

    const buffer=Buffer.from(x.ba    for(const k of ['autoApprove','th||buffer.length>10*1024*1024)
      return reply(res,400,{error:'Maximum file size 10 MB'});

    const start=Date.now();
    const result=await recognize(buffer,x.mime);
    const fields=extract(result.text);
    const all=read('invoices',[]);
    const id=crypto.randomUUID();
    const ext=x.mime==='application/pdf'?'pdf':
      x.mime==='image/png'?'png':'jpg';
    const gl=classify(fields.supplier+' '+result.text);

    const invoice={
      id,...fields,
      glCategory:gl,
      glCode:GL[gl][0],
      status:'Review Required',
      filename:String(x.name||'invoice').slice(0,140),
      documentFile:id+'.'+ext,
      documentMime:x.mime,
      ocrText:result      return reply(res,400,{error:'PDF, PNG and JPEG only'});
    ifSOString()
    };

    const ev=evaluate(invoice,all);
    invoice.issues=ev.issues;
    invoice.automation=ev;

    if(ev.eligible){
      invoice.status='Approved';
      invoice.approvedBy='Automation Engine';
      invoice.approvedAt=new Date().toISOString();
    }

    fs.writeFileSync(path.join(UP,invoice.documentFile),buffer);
    all.unshift(invoice);
    write('invoices',all);

    const runs=read('benchmark',[]);
    runs.unshift({
      id:crypto.randomUUID(),
      invoiceId:id,
      method:result.method,
      pages:result.pages,
      latencyMs:Date.now()-start,
      at:new Date().toISOString()
    });
    write('benchmark',r
    const invoice={
      id,...fiel,id,result.method);
    audit(
      ev.eligible?'AUTO_APPROVED':'REVIEW_REQUIRED',
      id,ev.reasons.join('; ')
    );
    return reply(res,201,invoice);
  }

  if(p.startsWith('/api/document/')&&method==='GET'){
    const id=p.split('/').pop();
    const i=read('invoices',[]).find(x=>x.id===id);
    if(!i?.documentFile)
      return reply(res,404,{error:'Document not found'});
    const file=path.join(UP,path.basename(i.documentFile));
    if(!fs.existsSync(file))
      return reply(res,404,{error:'Original document missing'});
    res.writeHead(200,{
      'Content-Type':i.documentMime||'application/octet-stream',
      'Content-Disposition':'inline',
      'X-Content-Type-Options':'nosniff'
    });
    return fs.createReadStream(file).pipe(res);
  }

  if(p==='/api/suppliers'&&method==='POST'){
        methodait input(req);
    const name=String(x.name||'').trim();
    if(!name)return reply(res,400,{error:'Supplier name required'});
    const all=read('suppliers',[]);
    if(all.some(s=>s.name.toLowerCase()===name.toLowerCase()))
      return reply(res,409,{error:'Supplier already exists'});
    const s={
      id:crypto.randomUUID(),name,
      email:String(x.email||''),
      category:String(x.category||'Other'),
      paymentTerms:String(x.paymentTerms||'Net 30')
    };
    all.unshift(s);
    write('suppliers',all);
    audit('SUPPLIER_CREATED',s.id,name);
    return reply(res,201,s);
  }

  const supplier=p.match(/^\/api\/suppliers\/([a-f0-9-]+)$/);
  if(supplier&&['PATCH','DELETE'].includes(method)){
    const all=read('suppliers',[]);
    const id      'Content-Disposition':'inline',
      'X-Content-Type-Oeply(res,404,{error:'Supplier not found'});

    if(method==='DELETE'){
      const old=all.splice(idx,1)[0];
      write('suppliers',all);
      audit('SUPPLIER_DELETED',old.id,old.name);
      return reply(res,200,{ok:true});
    }

    const x=await input(req);
    for(const k of ['name','email','category','paymentTerms'])
      if(x[k]!==undefined)all[idx][k]=String(x[k]).trim();
    if(!all[idx].name)
      return reply(res,400,{error:'Supplier name required'});
    write('suppliers',all);
    audit('SUPPLIER_UPDATED',all[idx].id,all[idx].name);
    return reply(res,200,all[idx]);
  }

  const invoice=p.match(/^\/api\/invoices\/([a-f0-9-]+)$/);
  if(invoice&&method==='PATCH'){
    co    audit('SUPPLIER_Cs',[]);
    const i=all.find(x=>x.id===invoice[1]);
    if(!i)return reply(res,404,{error:'Invoice not found'});
    if(i.status==='Approved')
      return reply(res,409,{error:'Reopen approved invoice first'});

    const x=await input(req);
    for(const k of [
      'supplier','number','invoiceDate',
      'dueDate','currency','glCategory'
    ])if(x[k]!==undefined)i[k]=String(x[k]).trim();

    if(x.amount!==undefined){
      if(!Number.isFinite(Number(x.amount))||Number(x.amount)<0)
        return reply(res,400,{error:'Invalid amount'});
      i.amount=Number(x.amount);
    }

    if(!GL[i.glCategory])
      return reply(res,400,{error:'Invalid GL category'});

    i.glCode=GL[i.glCategory][0];
    i.i    write('suppliall);
    i.automation=evaluate(i,all);
    write('invoices',all);
    audit('INVOICE_UPDATED',i.id,'Invoice corrected');
    return reply(res,200,i);
  }

  const workflow=p.match(/^\/api\/workflow\/([a-f0-9-]+)$/);
  if(workflow&&method==='POST'){
    const all=read('invoices',[]);
    const i=all.find(x=>x.id===workflow[1]);
    if(!i)return reply(res,404,{error:'Invoice not found'});
    const x=await input(req);
    const action=x.action;

    if(action==='reopen'){
      i.status='Review Required';
      delete i.approvedAt;
      delete i.approvedBy;
    }else if(action==='evaluate'){
      if(['Approved','Rejected'].includes(i.status))
        return reply(res,409,{error:'     n first'});
      const ev=evaluate(i,all);
      i.issues=ev.issues;
      i.automation=ev;
      i.status=ev.eligible?'Approved':'Review Required';
      if(ev.eligible){
        i.approvedBy='Automation Engine';
        i.approvedAt=new Date().toISOString();
      }
    }else if(action==='submit'){
      if(i.status==='Approved')
        return reply(res,409,{error:'Already approved'});
      i.status='Pending Approval';
    }else if(action==='reject'){
      if(i.status==='Approved')
        return reply(res,409,{error:'Reopen first'});
      i.status='Rejected';
    }else if(action==='approve'){
      if(i.status==='Approved')
        return reply(res,409,{error:'Already approved'});
      const ev=evaluate    const action=x.action;s.length)
        return reply(res,422,{
          error:'Fix validation issues before approval',
          issues:ev.issues
        });
      i.status='Approved';
      i.approvedBy='Manual Reviewer';
      i.approvedAt=new Date().toISOString();
    }else{
      return reply(res,400,{error:'Invalid workflow action'});
    }

    write('invoices',all);
    audit('WORKFLOW_'+action.toUpperCase(),i.id,i.status);
    return reply(res,200,i);
  }

  if(p==='/api/journal'&&method==='GET'){
    const rows=read('invoices',[])
      .filter(i=>i.status==='Approved')
      .flatMap(i=>{
        const gl=GL[i.glCategory]||GL.Other;
        return [
          {
            invoice:i.number,supplier:i.supplier,date:i.invoiceDate,
            account:gl[0],accountName:gl[1      i.status='Rejected';
    }else if(action===        },
          {
            invoice:i.number,supplier:i.supplier,date:i.invoiceDate,
            account:'2000',accountName:'Accounts Payable',
            debit:0,credit:Number(i.amount)
          }
        ];
      });
    return reply(res,200,rows);
  }

  return reply(res,404,{error:'Endpoint not found'});
}

http.createServer((req,res)=>{
  Promise.resolve(route(req,res)).catch(error=>{
    console.error(error);
    if(!res.headersSent)
      reply(res,500,{error:error.message});
    else res.end();
  });
}).listen(PORT,'127.0.0.1',()=>{
  console.log('MORROW READY http://127.0.0.1:'+PORT);
});
