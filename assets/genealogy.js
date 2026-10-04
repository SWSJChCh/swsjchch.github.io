/* Source-linked genealogy explorer. No runtime dependencies or network requests.
 * Layouts and collapsed paths are precomputed and validated at build time.
 * All text from the editable data file is inserted with textContent, never HTML.
 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const data = window.GENEALOGY_DATA;
  const error = message => { $('error-message').hidden = false; $('error-message').textContent = message; };
  if (!data || !Array.isArray(data.people) || !data.layouts) {
    error('The genealogy data could not be loaded. Please check that the four genealogy assets are installed.');
    return;
  }
  const people = new Map(data.people.map(p => [p.id, p]));
  const linkMap = new Map(data.links.map(e => [e.advisor + '>' + e.student, e]));
  const children = new Map(data.people.map(p => [p.id, []]));
  data.links.forEach(e => children.get(e.advisor)?.push(e.student));
  const card = data.meta.card, root = data.meta.root;
  const mobile = () => window.matchMedia('(max-width: 650px)').matches;
  const state = { view: 'highlights', mode: 'graph', selected: 'murray', edge: null, pathIndex: 0, trace: false, k: 1, x: 0, y: 0, fitted: true };
  const svg = $('genealogy-map'), world = $('graph-world'), panel = $('person-panel');
  let currentLayout, mini = null, searchMatches = [], searchIndex = -1, toastTimer, suppressClickUntil = 0, lastFocus = null;
  const MIN_ZOOM = .08, MAX_ZOOM = 2.4;

  function element(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = String(text);
    return e;
  }
  function svgElement(tag, attrs = {}, text) {
    const e = document.createElementNS(NS, tag);
    for (const [k,v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (text !== undefined) e.textContent = String(text);
    return e;
  }
  function external(label, url, className) {
    const a = element('a', className, label + ' ↗');
    try { const u = new URL(url); if (!['https:', 'http:'].includes(u.protocol)) return element('span', className, label); a.href = u.href; }
    catch { return element('span', className, label); }
    a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
  }
  function button(label, className, handler) { const b=element('button',className,label); b.type='button'; b.addEventListener('click',handler); return b; }
  function announce(message) { $('live-status').textContent = message; }
  function toast(message) { clearTimeout(toastTimer); $('toast').textContent=message; $('toast').hidden=false; toastTimer=setTimeout(()=>{$('toast').hidden=true;},3800); }
  function heading(text) { return element('h3','detail-heading',text); }
  function setHash() {
    try { history.replaceState(null, '', '#view=' + state.view + '&person=' + state.selected); } catch { /* Local previews may restrict history. */ }
  }
  const memo = new Map();
  function connectionStats(id, active = new Set()) {
    if (id === root) return { steps: 0, routes: 1n };
    if (memo.has(id)) return memo.get(id);
    if (active.has(id)) throw new Error('A cycle was found in the genealogy.');
    active.add(id);
    let steps=Infinity, routes=0n;
    for (const child of children.get(id) || []) { const s=connectionStats(child,active); steps=Math.min(steps,s.steps+1); routes+=s.routes; }
    active.delete(id); const result={steps,routes};memo.set(id,result);return result;
  }
  function traceSet(id) {
    const nodes=new Set(),edges=new Set();
    const visit=p=>{if(nodes.has(p))return;nodes.add(p);for(const child of children.get(p)||[]){edges.add(p+'>'+child);visit(child);}};
    visit(id);return {nodes,edges};
  }
  function sourceBlock(ids) {
    const block=element('div');
    [...new Set(ids)].forEach(id=>{const s=data.sources[id];if(!s)return;const a=external(s.title,s.url,'detail-source');a.append(element('span','source-kind',s.kind));block.append(a);});
    return block;
  }
  function edgeHistorical(e) { return e.paths.some(path=>path.slice(1).some((id,i)=>linkMap.get(path[i]+'>'+id)?.relation==='historical')); }
  function nodeHistorical(id) { return data.links.some(e=>(e.advisor===id||e.student===id)&&e.relation==='historical'); }

  function renderGraph() {
    currentLayout=data.layouts[state.view];
    $('graph-links').replaceChildren(); $('graph-nodes').replaceChildren();
    for (const e of currentLayout.edges) {
      const h=edgeHistorical(e);
      const g=svgElement('g',{class:'graph-edge'+(e.collapsed?' collapsed':'')+(h?' historical':''),'data-edge':e.key,tabindex:'0',role:'button','aria-label':people.get(e.advisor).label+' to '+people.get(e.student).label+(e.collapsed?', collapsed path. Select to reveal intermediate people.':', recorded connection. Select for sources.')});
      const title=e.collapsed?`${people.get(e.advisor).label} → ${people.get(e.student).label}. Select to reveal ${e.hiddenMin===e.hiddenMax?e.hiddenMin:e.hiddenMin+'–'+e.hiddenMax} intermediate people.`:`${people.get(e.advisor).label} → ${people.get(e.student).label}. Select for the connection’s source.`;
      g.append(svgElement('title',{},title),svgElement('path',{d:e.d,class:'edge-hit'}),svgElement('path',{d:e.d,class:'edge-visible'}));
      if (e.collapsed) {
        const label=e.hiddenMin===e.hiddenMax?'+'+e.hiddenMin:'+'+e.hiddenMin+'–'+e.hiddenMax;
        const w=Math.max(35,label.length*10+14);
        const badge=svgElement('g',{class:'edge-badge',transform:`translate(${e.badge.x},${e.badge.y})`});
        badge.append(svgElement('rect',{x:-w/2,y:-12,width:w,height:24,rx:6}),svgElement('text',{y:1},label));g.append(badge);
      }
      g.addEventListener('click',ev=>{ev.stopPropagation();if(performance.now()>suppressClickUntil) selectEdge(e.key);});
      g.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();selectEdge(e.key);}});
      g.addEventListener('focus',()=>ensureVisible(e.badge.x,e.badge.y,40,30));
      $('graph-links').append(g);
    }
    for (const [id,pos] of Object.entries(currentLayout.nodes)) {
      const p=people.get(id);
      const g=svgElement('g',{class:'node '+p.kind,'data-id':id,transform:`translate(${pos.x},${pos.y})`,tabindex:'0',role:'button','aria-label':p.name+'. '+p.caption+'. Select for a short biography and reading links.'});
      g.append(svgElement('title',{},p.name+' · '+p.dateLabel+' · '+p.caption),svgElement('rect',{class:'node-card',width:card.width,height:card.height,rx:7}));
      const date=id===root?'MY ACADEMIC LINEAGE':p.dateLabel;
      const nm=svgElement('text',{class:'node-name',x:16,y:44},p.label);
      if(p.label.length>23)nm.style.fontSize='21px';
      g.append(svgElement('text',{class:'node-date',x:16,y:18},date),nm,svgElement('text',{class:'node-caption',x:16,y:67},p.caption));
      if(nodeHistorical(id))g.append(svgElement('circle',{class:'historical-node-dot',cx:card.width-16,cy:16,r:3}));
      else if(p.kind==='highlight')g.append(svgElement('text',{class:'node-star',x:card.width-23,y:20},'✧'));
      g.addEventListener('click',ev=>{ev.stopPropagation();if(performance.now()>suppressClickUntil)selectPerson(id,{focus:false});});
      g.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();selectPerson(id,{focus:false});}});
      g.addEventListener('focus',()=>ensureVisible(pos.x,pos.y,card.width,card.height));
      $('graph-nodes').append(g);
    }
    $('view-count').textContent=Object.keys(currentLayout.nodes).length+(state.view==='highlights'?' selected people':state.view==='all'?' included people':' close-family members');
    $('map-description').textContent=state.view==='highlights'?'select a name or a + connection':'select a name or a connection';
    document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===state.view)));
    fitNodeLabels(); renderMini(); applySelection(); renderList();
  }
  function fitNodeLabels() {
    // Font metrics vary between EB Garamond and offline fallbacks.
    document.querySelectorAll('.node-name,.node-caption,.node-date').forEach(t=>{
      const width=t.getComputedTextLength(),available=card.width-32;
      if(width>available){const size=parseFloat(getComputedStyle(t).fontSize);t.style.fontSize=(size*available/width).toFixed(2)+'px';}
    });
  }
  document.fonts?.ready.then(fitNodeLabels);
  function renderMini() {
    const w=130,h=142,pad=7,k=Math.min((w-pad*2)/currentLayout.width,(h-pad*2)/currentLayout.height);
    mini={k,x:(w-currentLayout.width*k)/2,y:(h-currentLayout.height*k)/2};
    const g=$('mini-world');g.replaceChildren();g.setAttribute('transform',`translate(${mini.x},${mini.y}) scale(${k})`);
    for(const e of currentLayout.edges)g.append(svgElement('path',{d:e.d,class:'mini-edge'}));
    for(const [id,p] of Object.entries(currentLayout.nodes))g.append(svgElement('rect',{x:p.x,y:p.y,width:card.width,height:card.height,rx:5,class:'mini-node '+people.get(id).kind}));
    updateMini();
  }
  function updateMini() {
    if(!mini)return;
    const b=svg.getBoundingClientRect(),vp=$('mini-viewport');
    vp.setAttribute('x',mini.x-state.x/state.k*mini.k);vp.setAttribute('y',mini.y-state.y/state.k*mini.k);
    vp.setAttribute('width',b.width/state.k*mini.k);vp.setAttribute('height',b.height/state.k*mini.k);
  }
  function transform() {
    world.setAttribute('transform',`translate(${state.x.toFixed(2)},${state.y.toFixed(2)}) scale(${state.k.toFixed(5)})`);
    $('zoom-level').textContent=Math.round(state.k*100)+'%';updateMini();
  }
  function fit() {
    const b=svg.getBoundingClientRect();if(!b.width||!b.height)return;
    const top=75,bottom=67,pad=26;
    state.k=Math.min(1.18,(b.width-pad*2)/currentLayout.width,(b.height-top-bottom)/currentLayout.height);
    state.k=Math.max(MIN_ZOOM,state.k);state.x=(b.width-currentLayout.width*state.k)/2;state.y=top+(b.height-top-bottom-currentLayout.height*state.k)/2;
    state.fitted=true;transform();
  }
  function focusPerson(id,zoom) {
    const p=currentLayout.nodes[id];if(!p)return;
    const b=svg.getBoundingClientRect();state.k=Math.min(MAX_ZOOM,zoom||Math.max(state.k,mobile()?.9:1));
    state.x=b.width/2-(p.x+card.width/2)*state.k;
    state.y=b.height*(mobile()?.47:.55)-(p.y+card.height/2)*state.k;
    state.fitted=false;transform();
  }
  function ensureVisible(x,y,w,h) {
    if(state.mode!=='graph')return;
    const b=svg.getBoundingClientRect(),left=x*state.k+state.x,top=y*state.k+state.y;
    if(left<12||left+w*state.k>b.width-12||top<70||top+h*state.k>b.height-65){state.x=b.width/2-(x+w/2)*state.k;state.y=b.height/2-(y+h/2)*state.k;state.fitted=false;transform();}
  }
  function zoom(factor,cx,cy) {
    const b=svg.getBoundingClientRect();cx??=b.width/2;cy??=b.height/2;
    const k=Math.max(MIN_ZOOM,Math.min(MAX_ZOOM,state.k*factor));
    state.x=cx-(cx-state.x)*k/state.k;state.y=cy-(cy-state.y)*k/state.k;state.k=k;state.fitted=false;transform();
  }
  function applySelection() {
    const traced=state.trace?traceSet(state.selected):null;
    document.querySelectorAll('.node').forEach(g=>{const id=g.dataset.id;g.classList.toggle('selected',!state.edge&&id===state.selected);g.classList.toggle('dimmed',!!traced&&!traced.nodes.has(id));g.classList.toggle('traced',!!traced&&traced.nodes.has(id));g.setAttribute('aria-pressed',String(!state.edge&&id===state.selected));});
    document.querySelectorAll('.graph-edge').forEach(g=>{
      const e=currentLayout.edges.find(e=>e.key===g.dataset.edge);const active=!!traced&&e.paths.some(path=>path.slice(1).every((p,i)=>traced.edges.has(path[i]+'>'+p)));
      g.classList.toggle('active',active);g.classList.toggle('dimmed',!!traced&&!active);g.classList.toggle('edge-selected',g.dataset.edge===state.edge);
    });
    const route=$('route-toggle');route.disabled=state.selected===root;
    route.setAttribute('aria-pressed',String(state.trace));
    route.title=state.trace?'Clear highlighted routes':'Highlight routes from '+people.get(state.selected).label+' to Samuel';
    route.setAttribute('aria-label',route.title);
    document.querySelectorAll('.people-table tr[data-id]').forEach(tr=>tr.classList.toggle('selected',tr.dataset.id===state.selected&&!state.edge));
  }
  function closePersonPanel() {
    panel.classList.remove('open');
    if(lastFocus?.isConnected)lastFocus.focus({preventScroll:true});
  }
  function showPanel() {
    if(mobile()){
      if(!panel.contains(document.activeElement))lastFocus=document.activeElement;
      panel.classList.add('open');
      requestAnimationFrame(()=>{
        if(!panel.classList.contains('open'))return;
        panel.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
      });
    }
    panel.scrollTop=0;
  }
  function renderPerson() {
    const p=people.get(state.selected);
    const content=element('article','person-details biography');
    const header=element('header','biography-heading');
    const title=element('h2','person-name',p.name);title.id='biography-title';
    const close=button('×','close-details',closePersonPanel);
    close.setAttribute('aria-label','Close biography');
    header.append(title,close);content.append(header);
    content.append(element('p','person-description',p.description));
    if(p.reading?.length){
      const reading=element('nav','reading-links');
      reading.setAttribute('aria-label','Read more about '+p.name);
      p.reading.forEach(r=>reading.append(external(r.label,r.url)));
      content.append(reading);
    }
    $('person-details').replaceChildren(content);
  }
  function selectPerson(id,{focus=true,open=true}={}) {
    if(!people.has(id))return;
    closeSearch();if($('connection-dialog').open)$('connection-dialog').close();state.selected=id;state.edge=null;state.trace=false;
    if(!currentLayout.nodes[id]){state.view=data.meta.highlights.includes(id)?'highlights':'all';renderGraph();fit();}
    renderPerson();applySelection();if(focus)focusPerson(id);
    if(open)showPanel();setHash();announce(people.get(id).name+' selected. A short biography and reading links are available.');
  }
  function renderEdge() {
    const e=currentLayout.edges.find(e=>e.key===state.edge);if(!e)return;
    const path=e.paths[Math.min(state.pathIndex,e.paths.length-1)],h=edgeHistorical(e);
    const content=element('div','connection-content');
    $('connection-title').textContent=people.get(e.advisor).label+' → '+people.get(e.student).label;
    content.append(element('p','',e.collapsed?'This line compresses a chain in the included genealogy. It is not a direct supervision claim.':h?'A scholarly study or mentorship link in the cited historical genealogy.':'A direct adviser–student link in the cited genealogy record.'));
    if(e.paths.length>1){
      const sw=element('div','path-switch');
      const prev=button('←','',()=>{state.pathIndex=(state.pathIndex-1+e.paths.length)%e.paths.length;renderEdge();});prev.setAttribute('aria-label','Previous included path');
      const next=button('→','',()=>{state.pathIndex=(state.pathIndex+1)%e.paths.length;renderEdge();});next.setAttribute('aria-label','Next included path');
      sw.append(prev,element('span','',`Path ${state.pathIndex+1} of ${e.paths.length}`),next);content.append(sw);
    }
    const chain=element('ol','chain');
    path.forEach((id,i)=>{
      const li=element('li');
      li.append(button(people.get(id).label,'',()=>selectPerson(id)));
      if(i<path.length-1){const link=linkMap.get(id+'>'+path[i+1]);li.append(element('small','',link?.relation==='historical'?'Historical study / mentorship':'Recorded supervision'));}
      chain.append(li);
    });
    content.append(chain);
    if(e.collapsed)content.append(button('Show all connections ↗','primary-button',()=>{$('connection-dialog').close();setView('all');}));
    const sourceIds=path.slice(1).flatMap((id,i)=>linkMap.get(path[i]+'>'+id)?.sources||[]);
    content.append(element('hr','details-rule'),heading('Sources for this path'),sourceBlock(sourceIds));
    if(h)content.append(element('p','detail-note history','The historical portion is inherited from the cited genealogy sources; it should not be read as a sequence of modern doctorates.'));
    $('connection-details').replaceChildren(content);
  }
  function selectEdge(key) {
    const e=currentLayout.edges.find(e=>e.key===key);if(!e)return;
    state.edge=key;state.pathIndex=0;state.trace=false;renderEdge();applySelection();
    const connection=$('connection-dialog');
    if(!connection.open){if(typeof connection.showModal==='function')connection.showModal();else connection.setAttribute('open','');}
    announce('Connection selected. Intermediate names and sources are available in the connection dialog.');
  }
  function setView(view,{fitView=true}={}) {
    if(!data.layouts[view])return;
    const oldSelected=state.selected;state.view=view;state.edge=null;state.trace=false;
    if(!data.layouts[view].nodes[oldSelected])state.selected=view==='recent'?'murray':root;
    renderGraph();renderPerson();
    if(fitView){fit();if(view==='all'){focusPerson(state.selected,mobile()?.88:.86);toast('All 48 people are included. Drag to explore, or use Fit for an overview.');}else if(mobile()&&view==='highlights')focusPerson(state.selected,.72);}
    setHash();announce(view==='all'?'All 48 included people are displayed.':view==='recent'?'Close family: Samuel, Baker, Maini and Murray.':'16 selected names; dashed connections reveal intermediate people.');
  }
  function renderList() {
    const ids=Object.keys(currentLayout.nodes).sort((a,b)=>connectionStats(a).steps-connectionStats(b).steps||people.get(a).name.localeCompare(people.get(b).name));
    const rows=ids.map(id=>{const p=people.get(id),tr=element('tr');tr.dataset.id=id;const a=element('td');a.append(button(p.label,'',()=>selectPerson(id,{focus:false})));const b=element('td');b.append(document.createTextNode(p.dateLabel),element('span','',p.dateKind));tr.append(a,b,element('td','',p.caption));return tr;});$('people-list').replaceChildren(...rows);
  }
  function setMode(mode) {state.mode=mode;const list=mode==='list';$('map-shell').hidden=list;$('list-shell').hidden=!list;$('list-toggle').setAttribute('aria-pressed',String(list));$('list-toggle').setAttribute('aria-label',list?'Switch to graph view':'Switch to list view');$('list-toggle').title=list?'Switch to graph view':'Switch to list view';if(!list)requestAnimationFrame(()=>{if(state.fitted)fit();else transform();});}
  function normalise(s) {return s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();}
  function search() {
    const q=normalise($('person-search').value.trim());searchIndex=-1;
    if(!q){closeSearch();return;}
    searchMatches=data.people.filter(p=>normalise([p.name,p.label,p.caption,p.institution,p.description].join(' ')).includes(q)).sort((a,b)=>Number(normalise(b.name).startsWith(q))-Number(normalise(a.name).startsWith(q))).slice(0,12);
    $('search-results').replaceChildren();
    if(!searchMatches.length)$('search-results').append(element('li','no-results','No matching person in this selected genealogy.'));
    searchMatches.forEach((p,i)=>{const li=element('li');li.id='result-'+p.id;li.setAttribute('role','option');li.setAttribute('aria-selected','false');li.append(element('span','result-name',p.label),element('span','result-field',p.caption));li.addEventListener('mousedown',ev=>ev.preventDefault());li.addEventListener('click',()=>{$('person-search').value='';setMode('graph');selectPerson(p.id);});$('search-results').append(li);});
    $('search-results').hidden=false;$('person-search').setAttribute('aria-expanded','true');
  }
  function closeSearch() {$('search-results').hidden=true;$('person-search').setAttribute('aria-expanded','false');$('person-search').removeAttribute('aria-activedescendant');searchIndex=-1;}
  $('person-search').addEventListener('input',search);
  $('person-search').addEventListener('focus',()=>{if($('person-search').value)search();});
  $('person-search').addEventListener('keydown',ev=>{
    if(ev.key==='Escape'){ev.preventDefault();closeSearch();$('person-search').blur();return;}
    if(ev.key==='ArrowDown'||ev.key==='ArrowUp'){ev.preventDefault();if(!searchMatches.length)return;searchIndex=(searchIndex+(ev.key==='ArrowDown'?1:-1)+searchMatches.length)%searchMatches.length;[...$('search-results').querySelectorAll('[role=option]')].forEach((r,i)=>r.setAttribute('aria-selected',String(i===searchIndex)));$('person-search').setAttribute('aria-activedescendant','result-'+searchMatches[searchIndex].id);$('result-'+searchMatches[searchIndex].id).scrollIntoView({block:'nearest'});}
    if(ev.key==='Enter'&&searchMatches.length){ev.preventDefault();const p=searchMatches[Math.max(0,searchIndex)];$('person-search').value='';setMode('graph');selectPerson(p.id);$('person-search').blur();}
  });
  document.addEventListener('click',ev=>{if(!ev.target.closest('.search-wrap'))closeSearch();});

  // Pointer capture supports mouse dragging and two-finger touch gestures.
  const pointers=new Map();let gesture=null;
  function startGesture(){const a=[...pointers.values()];gesture=a.length>=2?{type:'pinch',distance:Math.hypot(a[1].x-a[0].x,a[1].y-a[0].y),cx:(a[0].x+a[1].x)/2,cy:(a[0].y+a[1].y)/2,k:state.k,x:state.x,y:state.y}:a.length?{type:'pan',px:a[0].x,py:a[0].y,x:state.x,y:state.y,moved:false}:null;}
  svg.addEventListener('pointerdown',ev=>{if(ev.pointerType==='mouse'&&ev.button!==0)return;const r=svg.getBoundingClientRect();pointers.set(ev.pointerId,{x:ev.clientX-r.left,y:ev.clientY-r.top});if(!ev.target.closest('[role=button]'))svg.focus({preventScroll:true});try{svg.setPointerCapture(ev.pointerId);}catch{}startGesture();});
  svg.addEventListener('pointermove',ev=>{if(!pointers.has(ev.pointerId)||!gesture)return;const r=svg.getBoundingClientRect();pointers.set(ev.pointerId,{x:ev.clientX-r.left,y:ev.clientY-r.top});const a=[...pointers.values()];
    if(gesture.type==='pinch'&&a.length>=2){const d=Math.hypot(a[1].x-a[0].x,a[1].y-a[0].y),cx=(a[0].x+a[1].x)/2,cy=(a[0].y+a[1].y)/2,k=Math.max(MIN_ZOOM,Math.min(MAX_ZOOM,gesture.k*d/Math.max(gesture.distance,1)));state.x=cx-(gesture.cx-gesture.x)*k/gesture.k;state.y=cy-(gesture.cy-gesture.y)*k/gesture.k;state.k=k;state.fitted=false;suppressClickUntil=performance.now()+400;transform();}
    else if(gesture.type==='pan'){const dx=a[0].x-gesture.px,dy=a[0].y-gesture.py;if(Math.hypot(dx,dy)>5||gesture.moved){gesture.moved=true;state.x=gesture.x+dx;state.y=gesture.y+dy;state.fitted=false;svg.classList.add('dragging');suppressClickUntil=performance.now()+200;transform();}}
  });
  function endPointer(ev){pointers.delete(ev.pointerId);try{svg.releasePointerCapture(ev.pointerId);}catch{}svg.classList.remove('dragging');startGesture();}
  svg.addEventListener('pointerup',endPointer);svg.addEventListener('pointercancel',endPointer);
  // Captured pointer clicks are retargeted to SVG in some browsers: resolve a tap
  // from its coordinates only when it has not become a pan or pinch.
  svg.addEventListener('pointerup',ev=>{if(performance.now()<suppressClickUntil)return;const target=document.elementFromPoint(ev.clientX,ev.clientY)?.closest('[data-id],[data-edge]');if(target?.dataset.id)selectPerson(target.dataset.id,{focus:false});else if(target?.dataset.edge)selectEdge(target.dataset.edge);});
  svg.addEventListener('wheel',ev=>{if(ev.ctrlKey||ev.metaKey){ev.preventDefault();const r=svg.getBoundingClientRect();zoom(Math.exp(-ev.deltaY*.006),ev.clientX-r.left,ev.clientY-r.top);}}, {passive:false});
  svg.addEventListener('keydown',ev=>{if(ev.target!==svg)return;let dx=0,dy=0;if(ev.key==='ArrowLeft')dx=55;if(ev.key==='ArrowRight')dx=-55;if(ev.key==='ArrowUp')dy=55;if(ev.key==='ArrowDown')dy=-55;if(dx||dy){ev.preventDefault();state.x+=dx;state.y+=dy;state.fitted=false;transform();}if(ev.key==='+'||ev.key==='='){ev.preventDefault();zoom(1.2);}if(ev.key==='-'){ev.preventDefault();zoom(1/1.2);}if(ev.key.toLowerCase()==='f'){ev.preventDefault();fit();}});
  document.addEventListener('keydown',ev=>{const typing=/INPUT|TEXTAREA|SELECT/.test(ev.target.tagName)||ev.target.isContentEditable;if(ev.key==='/'&&!typing&&!document.querySelector('dialog[open]')){ev.preventDefault();$('person-search').focus();}if(ev.key==='Escape'){panel.classList.remove('open');if(state.trace){state.trace=false;applySelection();renderPerson();}}});
  $('route-toggle').addEventListener('click',()=>{
    if(state.selected===root)return;
    state.edge=null;state.trace=!state.trace;applySelection();
    announce(state.trace?'Highlighted the included routes from '+people.get(state.selected).label+' to Samuel.':'Route highlight cleared.');
  });
  $('zoom-in').addEventListener('click',()=>zoom(1.25));$('zoom-out').addEventListener('click',()=>zoom(.8));$('fit-view').addEventListener('click',fit);$('overview').addEventListener('click',fit);
  document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{panel.classList.remove('open');setView(b.dataset.view);}));
  $('list-toggle').addEventListener('click',()=>setMode(state.mode==='graph'?'list':'graph'));
  $('fullscreen').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else if($('explorer').requestFullscreen)await $('explorer').requestFullscreen();else toast('Full screen is not supported by this browser.');}catch{toast('Full screen is not available in this browser context.');}});
  document.addEventListener('fullscreenchange',()=>{$('fullscreen').setAttribute('aria-label',document.fullscreenElement?'Exit full screen':'Enter full screen');requestAnimationFrame(fit);});
  let resizeTimer;new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(state.mode!=='graph')return;if(state.fitted)fit();else transform();},70);}).observe($('map-shell'));

  const dialog=$('sources-dialog');
  document.querySelectorAll('[data-open-sources]').forEach(b=>b.addEventListener('click',()=>{if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');}));
  $('close-sources').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',ev=>{if(ev.target===dialog){const r=dialog.getBoundingClientRect();if(ev.clientX<r.left||ev.clientX>r.right||ev.clientY<r.top||ev.clientY>r.bottom)dialog.close();}});
  const connectionDialog=$('connection-dialog');
  $('close-connection').addEventListener('click',()=>connectionDialog.close());
  connectionDialog.addEventListener('close',()=>{state.edge=null;applySelection();});
  connectionDialog.addEventListener('click',ev=>{if(ev.target===connectionDialog){const r=connectionDialog.getBoundingClientRect();if(ev.clientX<r.left||ev.clientX>r.right||ev.clientY<r.top||ev.clientY>r.bottom)connectionDialog.close();}});
  // Qualifications and provenance remain available globally, not in the biography sidebar.
  for(const p of data.people){
    const item=element('section','source-item');
    item.append(element('h3','',p.name),element('p','qualification',p.qualification+' · '+p.year+' · '+p.institution));
    if(p.thesis)item.append(element('p','thesis',p.thesis));
    if(p.note)item.append(element('p','detail-note',p.note));
    item.append(sourceBlock(p.sources));$('record-notes').append(item);
  }
  const sources=Object.entries(data.sources).filter(([,s])=>s.kind!=='Biographical context');
  for(const [,s]of sources){const item=element('div','source-item');item.append(external(s.title,s.url),element('small','',s.note||s.kind));$('source-list').append(item);}
  function download(content,type,name){const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=element('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);}
  $('export-data').addEventListener('click',()=>{download(JSON.stringify(data,null,2),'application/json','samuel-johnson-genealogy-data.json');toast('Saved the source-linked genealogy data.');});
  $('export-svg').addEventListener('click',()=>{
    const out=svgElement('svg',{xmlns:NS,width:currentLayout.width+70,height:currentLayout.height+116,viewBox:`-35 -78 ${currentLayout.width+70} ${currentLayout.height+116}`,role:'img','aria-label':'Samuel Johnson’s selected mathematical genealogy'});
    out.append(svgElement('rect',{x:-35,y:-78,width:currentLayout.width+70,height:currentLayout.height+116,fill:'#0e141b'}));
    out.append(svgElement('title',{},'Samuel Johnson · Mathematical genealogy'),svgElement('desc',{},data.meta.scope+' Dashed paths can be expanded in the interactive website. Sources are attached to the included JSON data.'));
    out.append(svgElement('text',{x:0,y:-45,fill:'#e6edf3','font-family':'Georgia, serif','font-size':25},'Samuel Johnson · Mathematical genealogy'));
    out.append(svgElement('text',{x:0,y:-18,fill:'#9caebc','font-family':'monospace','font-size':11},`${state.view} · arrows point towards students · dashed = intermediate people · historical links include mentorship`));
    out.append(svg.querySelector('defs').cloneNode(true));
    const copy=world.cloneNode(true);copy.removeAttribute('transform');
    const original=[...world.querySelectorAll('*')],clones=[...copy.querySelectorAll('*')];
    const props=['fill','stroke','stroke-width','stroke-dasharray','opacity','font-family','font-size','font-weight','letter-spacing','text-anchor','dominant-baseline','marker-end'];
    clones.forEach((node,i)=>{const cs=getComputedStyle(original[i]);for(const prop of props){let val=cs.getPropertyValue(prop);if(prop==='marker-end'&&val.includes('#'))val='url(#'+val.split('#')[1].replace(/["')].*$/,'')+')';node.style.setProperty(prop,val);}node.removeAttribute('tabindex');node.removeAttribute('role');node.removeAttribute('aria-pressed');});
    copy.querySelectorAll('.edge-hit').forEach(n=>n.remove());out.append(copy);
    download(new XMLSerializer().serializeToString(out),'image/svg+xml','samuel-johnson-genealogy-'+state.view+'.svg');toast('Saved this tree view as an SVG.');
  });
  try {
    for(const p of data.people)connectionStats(p.id);
    const params=new URLSearchParams(location.hash.slice(1));
    if(data.layouts[params.get('view')])state.view=params.get('view');
    if(people.has(params.get('person')))state.selected=params.get('person');
    if(!data.layouts[state.view].nodes[state.selected])state.view='all';
    $('highlight-count').textContent=data.meta.highlights.length;$('all-count').textContent=data.people.length;
    renderGraph();renderPerson();
    requestAnimationFrame(()=>{fit();if(mobile()&&state.view!=='recent')focusPerson(state.selected,.72);});
  } catch(err) { console.error(err);error('The genealogy could not be displayed. '+err.message); }
})();
