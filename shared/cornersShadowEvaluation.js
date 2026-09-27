const pct01=v=>{const n=Number(v);return Number.isFinite(n)?(n>1?n/100:n):null;};
const lineFromKey=k=>{const m=String(k||'').match(/^corners_over(\d)(\d)$/);return m?Number(m[1]+'.'+m[2]):null;};

export function evaluateCornersShadow(docs=[]){
  const rows=(docs||[]).filter(d=>d?.result==='settled'&&Number.isFinite(Number(d.totalCorners))
    &&d?.challenger?.status==='AVAILABLE'&&d?.lines&&d?.challenger?.lines);
  let currentAbs=0,challengerAbs=0,currentBrier=0,challengerBrier=0,lineCalls=0;
  for(const d of rows){
    const total=Number(d.totalCorners),cMean=Number(d.expectedTotal),hMean=Number(d.challenger.expectedTotal);
    if(Number.isFinite(cMean))currentAbs+=Math.abs(cMean-total);
    if(Number.isFinite(hMean))challengerAbs+=Math.abs(hMean-total);
    for(const key of Object.keys(d.lines)){
      const line=lineFromKey(key),p0=pct01(d.lines[key]),p1=pct01(d.challenger.lines[key]);
      if(line==null||p0==null||p1==null)continue;
      const y=total>line?1:0;
      currentBrier+=(p0-y)**2;challengerBrier+=(p1-y)**2;lineCalls++;
    }
  }
  const n=rows.length;
  const current={mae:n?+(currentAbs/n).toFixed(4):null,brier:lineCalls?+(currentBrier/lineCalls).toFixed(5):null};
  const challenger={mae:n?+(challengerAbs/n).toFixed(4):null,brier:lineCalls?+(challengerBrier/lineCalls).toFixed(5):null};
  const enough=n>=200&&lineCalls>=500;
  const pass=enough&&challenger.mae<current.mae&&challenger.brier<current.brier;
  return{
    status:!enough?'COLLECTING_SHADOW_RESULTS':pass?'EVIDENCE_PASS':'NO_IMPROVEMENT_PROVEN',
    fixtures:n,lineCalls,minimumFixtures:200,minimumLineCalls:500,current,challenger,
    delta:{mae:current.mae!=null&&challenger.mae!=null?+(challenger.mae-current.mae).toFixed(4):null,
      brier:current.brier!=null&&challenger.brier!=null?+(challenger.brier-current.brier).toFixed(5):null,lowerIsBetter:true},
    automaticPromotion:false,
  };
}
