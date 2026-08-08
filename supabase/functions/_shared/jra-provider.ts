import type { BetType, Entry, RaceOdds, RaceSummary } from "./types.ts";

const BASE="https://race.netkeiba.com";
const headers={"user-agent":"RaceLab-Personal/1.0","referer":`${BASE}/`};
const tracks:Record<string,string>={"01":"札幌","02":"函館","03":"福島","04":"新潟","05":"東京","06":"中山","07":"中京","08":"京都","09":"阪神","10":"小倉"};
const clean=(s:string)=>s.replace(/<[^>]+>/g," ").replace(/&nbsp;|&#160;/g," ").replace(/\s+/g," ").trim();
const num=(s?:string)=>{const n=Number((s??"").replace(/,/g,""));return Number.isFinite(n)?n:undefined};
const fetchText=async(url:string)=>{const r=await fetch(url,{headers});if(!r.ok)throw new Error(`JRA_SOURCE_HTTP_${r.status}`);return r.text()};

export interface JraDetail { race:RaceSummary; entries:Entry[]; odds:RaceOdds[] }

export class JraProvider{
  async getRaceList(date:string):Promise<RaceSummary[]>{
    const ymd=date.replaceAll("-","");
    const html=await fetchText(`${BASE}/top/race_list_sub.html?kaisai_date=${ymd}`);
    const ids=[...new Set([...html.matchAll(/race_id=(\d{12})/g)].map(m=>m[1]))];
    return ids.map(id=>{
      const at=html.indexOf(`race_id=${id}`),segment=html.slice(Math.max(0,at-700),at+1000),raceNumber=Number(id.slice(-2)),track=tracks[id.slice(4,6)]??`JRA${id.slice(4,6)}`;
      const time=segment.match(/(\d{1,2}:\d{2})/)?.[1]??"09:00",course=clean(segment).match(/(芝|ダート|障害)\s*(\d{3,4})m/),names=[...segment.matchAll(/<span[^>]*class="(?:ItemTitle|RaceName)"[^>]*>([\s\S]*?)<\/span>/g)];
      return {externalId:`jra:${id}`,raceDate:date,track,raceNumber,raceName:clean(names.at(-1)?.[1]??"")||`${track} ${raceNumber}R`,startTime:`${date}T${time}:00+09:00`,surface:course?.[1]==="芝"?"turf":"dirt",distance:num(course?.[2]),sourceUrl:`${BASE}/race/shutuba.html?race_id=${id}`};
    });
  }

  async getDetail(race:RaceSummary):Promise<JraDetail>{
    const id=race.externalId.replace("jra:",""),html=await fetchText(`${BASE}/race/shutuba.html?race_id=${id}`),entries:Entry[]=[];
    for(const m of html.matchAll(/<tr class="HorseList"[\s\S]*?<\/tr>/g)){
      const row=m[0],horse=row.match(/\/horse\/(\d+)[^>]*[^>]*title="([^"]+)"/),horseNumber=num(row.match(/class="Umaban\d+ Txt_C">\s*(\d+)/)?.[1]);
      if(!horse||!horseNumber)continue;const sexAge=clean(row.match(/class="Barei Txt_C">([\s\S]*?)<\/td>/)?.[1]??""),weight=clean(row.match(/class="Weight">([\s\S]*?)<\/td>/)?.[1]??"");
      entries.push({umaxScores:{horse_id:horse[1]},horseNumber,gateNumber:num(row.match(/class="Waku\d+ Txt_C"><span>(\d+)</)?.[1]),horseName:horse[2],sex:sexAge.slice(0,1),age:num(sexAge.slice(1)),jockey:row.match(/class="Jockey">[\s\S]*?title="([^"]+)"/)?.[1],trainer:row.match(/class="Trainer">[\s\S]*?title="([^"]+)"/)?.[1],weightCarried:num(row.match(/class="Barei Txt_C">[\s\S]*?<\/td>\s*<td class="Txt_C">\s*([\d.]+)/)?.[1]),horseWeight:num(weight.match(/\d+/)?.[0]),horseWeightDelta:num(weight.match(/\(([+-]?\d+)\)/)?.[1]),sourceData:{horse_id:horse[1]}});
    }
    const oddsJson=JSON.parse(await fetchText(`${BASE}/api/api_get_jra_odds.html?race_id=${id}&type=all&action=init`));
    const odds:RaceOdds[]=[];const map:Record<string,BetType|undefined>={"1":"win","2":"place","4":"quinella","5":"wide","6":"exacta","7":"trio","8":"trifecta"};
    for(const [code,items] of Object.entries(oddsJson?.data?.odds??{})){const type=map[code];if(!type)continue;for(const [combo,raw] of Object.entries(items as Record<string,string[]>)){const horses=combo.match(/.{2}/g)?.map(Number)??[],values=raw as string[],price=num(values[0]);if(price)odds.push({type,horses,odds:price,oddsMax:num(values[1]),popularity:num(values[2])})}}
    return {race,entries,odds};
  }
}
