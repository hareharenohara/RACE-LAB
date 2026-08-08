const SUPABASE_URL='https://lgpvvwymvqzhoqkpuyjv.supabase.co';
const SUPABASE_KEY='sb_publishable_OFguESiAuWQ8iHFzYgT-Mg_g-iL9-87';
const labels={conservative:'保守型',balanced:'バランス型',aggressive:'積極型'};
const betLabels={win:'単勝',place:'複勝',wide:'ワイド',quinella:'馬複',exacta:'馬単',trio:'3連複',trifecta:'3連単'};
let session=JSON.parse(localStorage.getItem('race-lab-session')||'null'),accounts=[],predictions=[],batches=[],allBets=[];
const yen=n=>`${n<0?'-':''}¥${Math.abs(Number(n||0)).toLocaleString()}`,pct=n=>`${Number(n||0).toFixed(1)}%`;

async function auth(path,body){const r=await fetch(`${SUPABASE_URL}/auth/v1/${path}`,{method:'POST',headers:{apikey:SUPABASE_KEY,'content-type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error(data.msg||data.error_description||data.message||'認証に失敗しました');return data}
async function api(table,query=''){const r=await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`,{headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${session.access_token}`}});if(r.status===401){logout();throw new Error('ログイン期限が切れました')}const data=await r.json();if(!r.ok)throw new Error(data.message||'データ取得に失敗しました');return data}
async function load(){
  try{
    [accounts,predictions,batches,allBets]=await Promise.all([
      api('strategy_accounts','select=*&order=strategy'),
      api('predictions','select=id,strategy,action,confidence,reason,predicted_at,races(id,track,race_number,race_name,start_time,surface,distance,condition,status),bets(id,bet_type,combination,stake,odds_at_prediction,estimated_probability,expected_value,settlements(return_amount,profit,is_hit))&order=predicted_at.desc&limit=100'),
      api('batch_runs','select=*&order=started_at.desc&limit=20'),
      api('bets','select=strategy,stake,settlements(return_amount,profit,is_hit)&limit=5000')]);
    render();
  }catch(e){showError(e.message)}
}
function render(){
  const total=accounts.reduce((n,a)=>n+Number(a.current_balance)-Number(a.initial_balance),0);document.querySelector('#total-profit').textContent=(total>=0?'+':'')+yen(total);
  document.querySelector('#strategy-cards').innerHTML=accounts.map(a=>{const profit=Number(a.current_balance)-Number(a.initial_balance),roi=a.total_staked?Number(a.total_returned)/Number(a.total_staked)*100:0;return `<article class="card"><div class="card-top"><span class="badge ${a.strategy}">${labels[a.strategy]}</span><small>独立運用</small></div><h3>現在残高</h3><strong>${yen(a.current_balance)}</strong><div class="stats"><div><small>累計損益</small><b class="${profit>=0?'positive':'negative'}">${profit>=0?'+':''}${yen(profit)}</b></div><div><small>回収率</small><b>${pct(roi)}</b></div><div><small>最低残高</small><b>${yen(a.minimum_balance)}</b></div></div></article>`}).join('');
  const max=Math.max(...accounts.map(a=>Math.abs(Number(a.current_balance))),1);document.querySelector('#balance-bars').innerHTML=accounts.map(a=>`<div class="balance-row"><span>${labels[a.strategy]}</span><i><b class="${a.strategy}" style="width:${Math.max(3,Math.abs(a.current_balance)/max*100)}%"></b></i><strong>${yen(a.current_balance)}</strong></div>`).join('');
  const latest=batches[0];document.querySelector('#last-run').textContent=latest?`最終実行 ${new Date(latest.started_at).toLocaleString('ja-JP')}`:'実行履歴なし';
  document.querySelector('#job-list').innerHTML=batches.slice(0,4).map(b=>`<div class="job"><i>${b.status==='succeeded'?'✓':'•'}</i><div><b>${b.target_date} / ${b.parser_version}</b><small>${b.races_fetched}レース・外部リクエスト ${b.api_requests}</small></div><time class="status ${b.status}">${b.status}</time></div>`).join('')||'<p class="empty">実行履歴はありません</p>';
  document.querySelector('#hero-chart').innerHTML=accounts.map(a=>`<i class="bar ${a.strategy}" style="height:${Math.max(15,Math.min(100,Number(a.current_balance)/1500))}%"></i>`).join('');
  renderTabs();renderAnalytics();renderAudit();
}
function renderTabs(){const ids=['conservative','balanced','aggressive'];document.querySelector('#strategy-tabs').innerHTML=ids.map((id,i)=>`<button class="${i===0?'active':''}" data-strategy="${id}">${labels[id]}</button>`).join('');showRaces('conservative')}
function showRaces(strategy){
  const list=predictions.filter(p=>p.strategy===strategy);
  document.querySelector('#race-list').innerHTML=list.map(p=>{
    const r=p.races,bets=p.bets||[],stake=bets.reduce((n,b)=>n+Number(b.stake),0);
    const settlementOf=b=>Array.isArray(b.settlements)?b.settlements[0]:b.settlements;
    const settled=bets.filter(b=>settlementOf(b)),returned=settled.reduce((n,b)=>n+Number(settlementOf(b).return_amount),0);
    const isSettled=r.status==='finished'&&(p.action==='skip'||settled.length===bets.length),profit=returned-stake;
    const outcome=p.action==='skip'?'skip':!isSettled?'pending':returned>0?'hit':'miss';
    const outcomeLabel={skip:'見送り',pending:'結果待ち',hit:'的中',miss:'ハズレ'}[outcome];
    const betHtml=p.action==='skip'?'<span class="bet skip">見送り</span>':bets.map(b=>{
      const s=settlementOf(b),state=!s?'pending':s.is_hit?'hit':'miss';
      const result=!s?'結果待ち':s.is_hit?`的中・払戻 ${yen(s.return_amount)}`:'ハズレ';
      return `<span class="bet bet-${state}">${betLabels[b.bet_type]} ${b.combination.join('-')}・投資 ${yen(b.stake)}<small>${result}</small></span>`;
    }).join('');
    const money=p.action==='skip'
      ?'<div class="result-money"><span>購入なし</span></div>'
      :`<div class="result-money"><span>投資 <b>${yen(stake)}</b></span><span>払戻 <b>${isSettled?yen(returned):'---'}</b></span><span>収支 <b class="${isSettled?(profit>=0?'positive':'negative'):''}">${isSettled?(profit>=0?'+':'')+yen(profit):'---'}</b></span></div>`;
    return `<article class="race race-${outcome}"><div class="race-id"><small>${new Date(p.predicted_at).toLocaleDateString('ja-JP')}</small><strong>${r.track} ${r.race_number}R</strong><small>${r.surface==='turf'?'芝':'ダート'} ${r.distance||'---'}m・${new Date(r.start_time).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'})}</small></div><div class="race-main"><div class="outcome-line"><h3>${r.race_name}</h3><span class="outcome outcome-${outcome}">${outcomeLabel}</span></div><p>${p.reason}</p><div class="bets">${betHtml}</div></div><div class="race-result">${money}<small>信頼度 ${p.confidence}%</small></div></article>`;
  }).join('')||'<div class="empty panel">この戦略の予想はまだありません</div>';
}
function statsFor(strategy){const bets=allBets.filter(b=>b.strategy===strategy),settlementOf=b=>Array.isArray(b.settlements)?b.settlements[0]:b.settlements,staked=bets.reduce((n,b)=>n+Number(b.stake),0),settled=bets.filter(b=>settlementOf(b)),returned=settled.reduce((n,b)=>n+Number(settlementOf(b).return_amount),0),hits=settled.filter(b=>settlementOf(b).is_hit).length;return{staked,returned,profit:returned-staked,roi:staked?returned/staked*100:0,hit:settled.length?hits/settled.length*100:0}}
function renderAnalytics(){const s=accounts.map(a=>({...a,...statsFor(a.strategy)})),tot=s.reduce((x,a)=>({staked:x.staked+a.staked,returned:x.returned+a.returned}),{staked:0,returned:0});document.querySelector('#analysis-metrics').innerHTML=[['総予想',predictions.length],['総購入額',yen(tot.staked)],['総払戻額',yen(tot.returned)],['合算回収率',pct(tot.staked?tot.returned/tot.staked*100:0)]].map(x=>`<div class="metric"><small>${x[0]}</small><strong>${x[1]}</strong></div>`).join('');document.querySelector('#analysis-table').innerHTML=s.map(a=>`<tr><td><span class="badge ${a.strategy}">${labels[a.strategy]}</span></td><td>${yen(a.staked)}</td><td>${yen(a.returned)}</td><td class="${a.profit>=0?'positive':'negative'}">${yen(a.profit)}</td><td>${pct(a.roi)}</td><td>${pct(a.hit)}</td><td>${yen(a.minimum_balance)}</td></tr>`).join('')}
function renderAudit(){document.querySelector('#audit-list').innerHTML=batches.map(b=>`<div class="audit-row"><b>${new Date(b.started_at).toLocaleString('ja-JP')}</b><span>${b.parser_version}<small>${b.races_fetched}レース / API ${b.api_requests}回${b.error_message?' / '+b.error_message:''}</small></span><em class="status ${b.status}">${b.status}</em></div>`).join('')||'<p class="empty">履歴はありません</p>'}
function showError(message){const el=document.querySelector('#error');el.hidden=false;el.textContent=message}
function logout(){localStorage.removeItem('race-lab-session');session=null;document.querySelector('#auth').classList.remove('hidden')}
document.querySelector('#auth-form').addEventListener('submit',async e=>{e.preventDefault();const m=document.querySelector('#auth-message'),emailValue=document.querySelector('#email').value,passwordValue=document.querySelector('#password').value;try{m.textContent='ログイン中…';session=await auth('token?grant_type=password',{email:emailValue,password:passwordValue});localStorage.setItem('race-lab-session',JSON.stringify(session));document.querySelector('#auth').classList.add('hidden');m.textContent='';load()}catch(err){m.textContent=err.message}});
document.querySelector('#signup').addEventListener('click',async()=>{const m=document.querySelector('#auth-message'),emailValue=document.querySelector('#email').value,passwordValue=document.querySelector('#password').value;try{m.textContent='作成中…';const data=await auth('signup',{email:emailValue,password:passwordValue,data:{display_name:emailValue.split('@')[0]}});if(data.access_token){session=data;localStorage.setItem('race-lab-session',JSON.stringify(data));document.querySelector('#auth').classList.add('hidden');load()}else m.textContent='確認メールを送信しました。確認後にログインしてください。'}catch(err){m.textContent=err.message}});
document.querySelector('#logout').onclick=logout;document.addEventListener('click',e=>{const nav=e.target.closest('[data-page]');if(nav){document.querySelectorAll('[data-page],.page').forEach(x=>x.classList.remove('active'));nav.classList.add('active');document.querySelector('#'+nav.dataset.page).classList.add('active');document.querySelector('#page-title').textContent=nav.textContent}const tab=e.target.closest('[data-strategy]');if(tab){document.querySelectorAll('[data-strategy]').forEach(x=>x.classList.remove('active'));tab.classList.add('active');showRaces(tab.dataset.strategy)}});
document.querySelector('#today-label').textContent=new Date().toLocaleDateString('ja-JP',{year:'numeric',month:'long',day:'numeric',weekday:'long'});if(session?.access_token){document.querySelector('#auth').classList.add('hidden');load()}
setInterval(()=>{if(session?.access_token)load()},60000);
