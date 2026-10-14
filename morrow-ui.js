
(function(){
  function getState(){
    if(typeof window.morrowGetState==="function")return window.morrowGetState();
    return {invoices:[],page:""};
  }
  async function api(url,options={}){
    const r=await fetch(url,{
      ...options,
      headers:{"Content-Type":"application/json",...(options.headers||{})}
    });
    const data=await r.json();
    if(!r.ok)throw Error(data.error||"Request failed");
    return data;
  }
  function escapeHTML(s){
    return String(s??"").replace(/[&<>"']/g,c=>({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    })[c]);
  }
  function enhance(){
    const state=getState();
    if(state.page==="AI Processing"){
      const file=document.querySelector('input[type="file"]');
      if(file&&!file.dataset.morrow){
        file.dataset.morrow="1";
        file.removeAttribute("onchange");
        file.addEventListener("change",e=>window.morrowUpload(e.target));
        const wrapper=document.createElement("div");
        wrapper.style.margin="16px 0";
        wrapper.innerHTML='<label style="display:block;margin-bottom:8px">Processing method</label><select id="morrowMode" style="padding:12px;border:1px solid #ddd;border-radius:8px;width:100%;max-width:400px"><option value="hybrid">Hybrid OCR + Vision LLM</option><option value="ocr">OCR / PDF text only</option></select><p id="morrowStatus" style="margin-top:12px"></p>';
        file.parentNode.insertBefore(wrapper,file);
        api("/api/morrow/config").then(x=>{
          if(!x.aiConfigured){
            const mode=document.getElementById("morrowMode");
            if(mode)mode.value="ocr";
          }
        }).catch(()=>{});
      }
    }
    if(state.page==="Automation"){
      const main=document.querySelector("main")||
        document.getElementById("app");

      if(main&&!document.getElementById("morrowAutomation")){
        const section=document.createElement("section");
        section.id="morrowAutomation";
        section.style="background:#fff;border:1px solid #E3E7E5;border-radius:12px;padding:24px;margin:20px 0";
        section.innerHTML=`
          <h2 style="margin:0 0 8px">Approval Rule Engine</h2>
          <p style="color:#78838A;margin-bottom:20px">
            Configure rules applied to newly processed invoices.
          </p>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:18px">
            <label><input type="checkbox" id="ruleAuto"> Enable automatic approval</label>
            <label><input type="checkbox" id="ruleDuplicate"> Block duplicate invoices</label>
            <label><input type="checkbox" id="ruleRequired"> Require valid invoice fields</label>
            <label>Auto-approval limit (USD)
              <input id="ruleMax" type="number" min="0" step="0.01" style="display:block;padding:10px;width:100%;margin-top:8px">
            </label>
            <label>Senior approval threshold (USD)
              <input id="ruleThreshold" type="number" min="0" step="0.01" style="display:block;padding:10px;width:100%;margin-top:8px">
            </label>
          </div>
          <button id="ruleSave" style="margin-top:22px;padding:12px 20px;background:#879B86;color:white;border:0;border-radius:8px;cursor:pointer">
            Save automation rules
          </button>
          <p id="ruleMessage" style="margin-top:12px"></p>
        `;
        main.prepend(section);

        api("/api/morrow/rules").then(r=>{
          document.getElementById("ruleAuto").checked=r.autoApproveEnabled;
          document.getElementById("ruleDuplicate").checked=r.blockDuplicates;
          document.getElementById("ruleRequired").checked=r.requireCompleteFields;
          document.getElementById("ruleMax").value=r.autoApproveMaxAmount;
          document.getElementById("ruleThreshold").value=r.approvalThreshold;
        }).catch(e=>{
          document.getElementById("ruleMessage").textContent=e.message;
        });

        document.getElementById("ruleSave").onclick=async()=>{
          const message=document.getElementById("ruleMessage");
          try{
            await api("/api/morrow/rules",{
              method:"PATCH",
              body:JSON.stringify({
                autoApproveEnabled:document.getElementById("ruleAuto").checked,
                blockDuplicates:document.getElementById("ruleDuplicate").checked,
                requireCompleteFields:document.getElementById("ruleRequired").checked,
                autoApproveMaxAmount:Number(document.getElementById("ruleMax").value),
                approvalThreshold:Number(document.getElementById("ruleThreshold").value)
              })
            });
            message.textContent="Rules saved and active.";
          }catch(e){
            message.textContent="Error: "+e.message;
          }
        };
      }
    }
    if(state.page==="Accounting"){
      const main=document.querySelector("main")||document.getElementById("app");
      if(main&&!document.getElementById("morrowExport")){
        const button=document.createElement("button");
        button.id="morrowExport";
        button.textContent="Export General Ledger CSV";
        button.style="margin:16px;padding:12px 18px;background:#879B86;color:white;border:0;border-radius:8px;cursor:pointer";
        button.onclick=window.morrowExportJournal;
        main.prepend(button);
      }
    }
  }
  window.morrowUpload=async function(input){
    const file=input.files?.[0];
    if(!file)return;
    const status=document.getElementById("morrowStatus");
    if(status)status.textContent="Processing document...";
    try{
      if(file.size>10*1024*1024)throw Error("Maximum 10 MB");
      const base64=await new Promise((resolve,reject)=>{
        const reader=new FileReader();
        reader.onload=()=>resolve(String(reader.result).split(",")[1]);
        reader.onerror=reject;
        reader.readAsDataURL(file);
      });
      const result=await api("/api/morrow/process",{
        method:"POST",
        body:JSON.stringify({
          name:file.name,
          mime:file.type,
          base64,
          mode:document.getElementById("morrowMode")?.value||"ocr"
        })
      });
      if(typeof window.refresh==="function")await window.refresh();
      if(typeof window.go==="function")window.go("Invoices");
      if(typeof window.openInvoice==="function")window.openInvoice(result.invoice.id);
    }catch(e){
      if(status)status.textContent="Error: "+e.message;
      alert(e.message);
    }
  };
  window.morrowExportJournal=async function(){
    try{
      const rows=await api("/api/morrow/journal");
      if(!rows.length)return alert("No approved invoices to export.");
      const keys=["invoice","supplier","date","account","accountName","debit","credit"];
      const q=x=>'"'+String(x??"").replaceAll('"','""')+'"';
      const csv=[keys.join(","),...rows.map(row=>keys.map(k=>q(row[k])).join(","))].join("\n");
      const blob=new Blob([csv],{type:"text/csv;charset=utf-8"});
      const url=URL.createObjectURL(blob);
      const a=document.createElement("a");
      a.href=url;a.download="morrow-general-ledger.csv";a.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(e){alert(e.message)}
  };
  const originalOpen=window.openInvoice;
  if(typeof originalOpen==="function"){
    window.openInvoice=function(id){
      originalOpen(id);
      const invoice=getState().invoices.find(x=>x.id===id);
      const drawer=document.getElementById("drawerBody");
      if(!invoice||!drawer)return;
      const old=document.getElementById("morrowInvoiceExtra");
      if(old)old.remove();
      const extra=document.createElement("section");
      extra.id="morrowInvoiceExtra";
      extra.style="margin-top:24px;padding-top:20px;border-top:1px solid #ddd";
      if(invoice.documentFile){
        const title=document.createElement("h3");
        title.textContent="Original document";
        extra.append(title);
        const frame=document.createElement("iframe");
        frame.src="/api/morrow/document/"+encodeURIComponent(id);
        frame.title="Original invoice";
        frame.style="width:100%;height:330px;border:1px solid #ddd;border-radius:8px";
        extra.append(frame);
      }
      const label=document.createElement("label");
      label.textContent="GL classification";
      label.style="display:block;margin:16px 0 8px";
      extra.append(label);
      const select=document.createElement("select");
      select.style="padding:10px;width:100%;border:1px solid #ddd;border-radius:8px";
      for(const category of ["Packaging","Logistics","Marketing","Software","Manufacturing","Professional Services","Other"]){
        const option=document.createElement("option");
        option.value=category;
        option.textContent=category;
        option.selected=invoice.glCategory===category;
        select.append(option);
      }
      select.disabled=invoice.status==="Approved";
      extra.append(select);
      if(!select.disabled){
        const button=document.createElement("button");
        button.textContent="Save GL account";
        button.style="display:block;margin-top:12px;padding:10px 16px;background:#879B86;color:white;border:0;border-radius:8px;cursor:pointer";
        button.onclick=async()=>{
          try{
            await api("/api/morrow/invoice/"+id+"/gl",{
              method:"PATCH",body:JSON.stringify({category:select.value})
            });
            if(typeof window.refresh==="function")await window.refresh();
            window.openInvoice(id);
          }catch(e){alert(e.message)}
        };
        extra.append(button);
      }
      drawer.append(extra);
    };
  }
  const observer=new MutationObserver(()=>{
    if(!window.morrowEnhancing){
      window.morrowEnhancing=true;
      requestAnimationFrame(()=>{
        window.morrowEnhancing=false;
        enhance();
      });
    }
  });
  observer.observe(document.body,{childList:true,subtree:true});
  enhance();
})();
