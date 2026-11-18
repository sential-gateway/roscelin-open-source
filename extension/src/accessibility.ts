// Shared keyboard semantics and explicitly initiated, local-only speech.
export function navigationIndex(key:string,index:number,count:number):number|null {
  if(!count)return null;
  if(key==='Home')return 0;if(key==='End')return count-1;
  if(key==='ArrowRight'||key==='ArrowDown')return (index+1)%count;
  if(key==='ArrowLeft'||key==='ArrowUp')return (index-1+count)%count;
  return null;
}
export class LocalReadAloud {
  private generation=0;
  private speaking=false;
  private options:any;
  constructor(options:{synthesis:any;Utterance:any;status:(text:string)=>void}){this.options=options;}
  // Announce only when speech was active: stop() also runs on Escape, tab switch, page hide and workspace Stop.
  stop(){const was=this.speaking;this.halt();if(was)this.options.status('Read aloud stopped.');}
  private halt(){this.generation++;this.speaking=false;this.options.synthesis?.cancel();}
  read(text:string){
    this.halt();
    const {synthesis,Utterance,status}=this.options;
    const voice=synthesis?.getVoices().find((v:any)=>v.localService===true&&/^en(?:-|$)/i.test(v.lang));
    if(!voice||!Utterance){status('No local English voice is available. No remote voice was used.');return;}
    if(!text.trim()){status('There is no workspace text to read.');return;}
    const id=this.generation;
    const utterance=new Utterance(text.slice(0,12000));utterance.voice=voice;utterance.lang=voice.lang;
    utterance.onend=()=>{if(id===this.generation){this.speaking=false;status('Read aloud finished.');}};
    utterance.onerror=()=>{if(id===this.generation){this.speaking=false;status('Read aloud could not continue. No remote fallback was used.');}};
    try{synthesis.speak(utterance);this.speaking=true;status('Reading workspace aloud using a local voice.');}
    catch{status('Read aloud could not start. No remote fallback was used.');}
  }
}
