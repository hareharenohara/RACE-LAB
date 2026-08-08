import type { BetType, Strategy } from "./types.ts";

export const STRATEGIES:Strategy[]=["conservative","balanced","aggressive"];
export const BET_TYPES:BetType[]=["win","place","wide","quinella","exacta","trio","trifecta"];

export interface ValidSelection { race_id:string; score:number; reason:string }
export function validateSelections(value:unknown,validRaceIds:Set<string>):Record<Strategy,ValidSelection[]>{
  if(!value||typeof value!=="object")throw new Error("SELECTION_NOT_OBJECT");
  const root=value as Record<string,unknown>; const result={} as Record<Strategy,ValidSelection[]>;
  for(const strategy of STRATEGIES){
    if(!Array.isArray(root[strategy]))throw new Error(`SELECTION_${strategy}_NOT_ARRAY`);
    const items=(root[strategy] as Record<string,unknown>[]).map(item=>({race_id:String(item.race_id??""),score:Number(item.score),reason:String(item.reason??"")}));
    const ids=items.map(item=>item.race_id);
    if(ids.length>3||new Set(ids).size!==ids.length||ids.some(id=>!validRaceIds.has(id)))throw new Error(`SELECTION_${strategy}_INVALID`);
    if(items.some(item=>!Number.isInteger(item.score)||item.score<0||item.score>100||!item.reason))throw new Error(`SELECTION_${strategy}_FIELDS_INVALID`);
    result[strategy]=items;
  } return result;
}

export function validatePredictions(value:unknown,strategy:Strategy,validRaceIds:Set<string>,horseNumbers:Map<string,Set<number>>){
  if(!value||typeof value!=="object")throw new Error("PREDICTION_NOT_OBJECT");
  const root=value as Record<string,unknown>;
  if(root.strategy!==strategy||!Array.isArray(root.predictions))throw new Error("PREDICTION_SHAPE_INVALID");
  const seen=new Set<string>();
  const horseCount:Record<BetType,number>={win:1,place:1,wide:2,quinella:2,exacta:2,trio:3,trifecta:3};
  for(const raw of root.predictions as Record<string,unknown>[]){
    const raceId=String(raw.race_id??""); if(!validRaceIds.has(raceId))throw new Error("PREDICTION_RACE_INVALID");
    if(seen.has(raceId))throw new Error("PREDICTION_RACE_DUPLICATE"); seen.add(raceId);
    if(!["BET","SKIP"].includes(String(raw.action)))throw new Error("PREDICTION_ACTION_INVALID");
    const confidence=Number(raw.confidence); if(!Number.isInteger(confidence)||confidence<0||confidence>100)throw new Error("PREDICTION_CONFIDENCE_INVALID");
    const bets=raw.bets; if(!Array.isArray(bets))throw new Error("PREDICTION_BETS_INVALID");
    if(raw.action==="SKIP"&&bets.length)throw new Error("SKIP_WITH_BETS");
    if(raw.action==="BET"&&!bets.length)throw new Error("BET_WITHOUT_BETS");
    for(const bet of bets as Record<string,unknown>[]){
      if(!BET_TYPES.includes(bet.type as BetType))throw new Error("BET_TYPE_INVALID");
      const stake=Number(bet.stake); if(!Number.isInteger(stake)||stake<=0||stake%100!==0)throw new Error("BET_STAKE_INVALID");
      if(!Array.isArray(bet.horses)||bet.horses.length!==horseCount[bet.type as BetType]||new Set(bet.horses.map(Number)).size!==bet.horses.length||bet.horses.some(n=>!horseNumbers.get(raceId)?.has(Number(n))))throw new Error("BET_HORSES_INVALID");
    }
  } return root as {strategy:Strategy;predictions:Record<string,unknown>[]};
}

export const SELECTION_SCHEMA={type:"object",properties:Object.fromEntries(STRATEGIES.map(strategy=>[strategy,{type:"array",maxItems:3,items:{type:"object",properties:{race_id:{type:"string"},score:{type:"integer",minimum:0,maximum:100},reason:{type:"string"}},required:["race_id","score","reason"]}}])),required:STRATEGIES};

export const PREDICTION_SCHEMA={type:"object",properties:{strategy:{type:"string",enum:STRATEGIES},predictions:{type:"array",items:{type:"object",properties:{race_id:{type:"string"},action:{type:"string",enum:["BET","SKIP"]},confidence:{type:"integer",minimum:0,maximum:100},reason:{type:"string"},bets:{type:"array",items:{type:"object",properties:{type:{type:"string",enum:BET_TYPES},horses:{type:"array",items:{type:"integer"}},stake:{type:"integer",minimum:100},estimated_probability:{type:"number",minimum:0,maximum:1}},required:["type","horses","stake","estimated_probability"]}}},required:["race_id","action","confidence","reason","bets"]}}},required:["strategy","predictions"]};
