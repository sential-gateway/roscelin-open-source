// Foreground, on-device-only dictation. Never sends requests, submits forms, or executes actions.
export class Dictation {
  private generation=0;
  private recognition:any=null;
  private timer:any=null;
  private finishing=false;
  active=false;
  text='';
  private options:any;
  constructor(options:{Recognition:any;change:(s:{active:boolean;text:string;status:string})=>void;setTimer?:(fn:()=>void,ms:number)=>any;clearTimer?:(id:any)=>void}){this.options=options;}
  private emit(status:string){this.options.change({active:this.active,text:this.text,status});}
  private end(status:string,discard=false){
    this.generation++;const r=this.recognition;this.recognition=null;this.active=false;this.finishing=false;
    if(this.timer!==null)(this.options.clearTimer??clearTimeout)(this.timer);this.timer=null;
    if(discard)this.text='';try{r?.abort();}catch{}this.emit(status);
  }
  cancel(){this.end('Dictation cancelled. Nothing inserted.',true);}
  stop(){
    if(this.finishing)return;
    const r=this.recognition;if(!r){this.end('Dictation stopped before the microphone started.');return;}
    this.finishing=true;this.emit('Finishing transcription. Cancel to discard.');
    if(this.timer!==null)(this.options.clearTimer??clearTimeout)(this.timer);
    const id=this.generation;this.timer=(this.options.setTimer??setTimeout)(()=>{if(id===this.generation)this.end('Stopped waiting for final speech. Review any captured text.');},3000);
    try{r.stop();}catch{this.end('Microphone stopped. Review any captured text.');}
  }
  async start(consent:boolean){
    if(this.active)return;
    if(!consent){this.emit('Check microphone consent before starting.');return;}
    const R=this.options.Recognition;
    if(!R||typeof R.available!=='function'){this.emit('On-device dictation is unavailable in this browser. You can still type. No remote speech service was used.');return;}
    const id=++this.generation;this.active=true;this.text='';this.emit('Checking on-device dictation. Microphone not started.');
    // Bound permission/availability waits as well as recording; never automatically restart.
    this.timer=(this.options.setTimer??setTimeout)(()=>{if(id===this.generation)this.stop();},60000);
    try {
      const r=new R();if(!('processLocally' in r))throw Error('local-unsupported');
      r.processLocally=true;r.lang='en-US';r.continuous=false;r.interimResults=false;r.maxAlternatives=1;
      if(r.processLocally!==true)throw Error('local-unsupported');
      const availability=await R.available({langs:['en-US'],processLocally:true});
      if(id!==this.generation)return;
      if(availability!=='available'){this.end('On-device English (US) dictation is not ready in this browser. No language pack was installed and no remote fallback was used. You can still type.');return;}
      this.recognition=r;
      r.onstart=()=>{if(id===this.generation)this.emit('Listening on device. Stop or Cancel at any time.');};
      r.onresult=(event:any)=>{
        if(id!==this.generation)return;
        // Rebuild from the complete final result list so repeated events cannot duplicate text.
        const parts:string[]=[];for(let i=0;i<Math.min(event.results?.length??0,100);i++){const result=event.results[i];if(result?.isFinal&&typeof result[0]?.transcript==='string')parts.push(result[0].transcript);}
        this.text=parts.join(' ').slice(0,2000);this.emit(this.finishing?'Finishing transcription. Captured text is a draft, not a command.':'Listening on device. Captured text is a draft, not a command.');
        if(this.text.length>=2000)this.end('Dictation reached the 2,000-character limit. Review before inserting.');
      };
      r.onerror=(event:any)=>{if(id!==this.generation)return;const messages:Record<string,string>={'not-allowed':'Microphone permission was denied. You can still type.','audio-capture':'No usable microphone was found.','no-speech':'No speech was detected.','language-not-supported':'On-device English (US) recognition is unavailable.','network':'The browser reported a speech-service error. No remote fallback was attempted.','service-not-allowed':'This browser does not allow this on-device speech service.'};this.end(messages[event.error]??'Dictation stopped with a browser error. You can retry or type.');};
      r.onend=()=>{if(id===this.generation)this.end(this.text?'Finished. Review and edit the draft, then insert it.':'No speech captured. You can retry or type.');};
      this.emit('Waiting for microphone permission. Cancel if you do not want to continue.');r.start();
    }catch{if(id===this.generation)this.end('On-device dictation could not start here. No remote fallback was used. You can still type.');}
  }
}
