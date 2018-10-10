"use strict";
function jsSID(_bufferlen) {
    this.play  = play;
    this.pause = pause;
    this.load  = load;
    
    var node, ctx, isConn, bufferlen;
    var sidcore, subtune, filedata;
    
    bufferlen = _bufferlen;
    
    ctx = new (AudioContext || webkitAudioContext)();
    if        (typeof ctx.createJavaScriptNode !== 'undefined') {
        node = ctx.createJavaScriptNode(bufferlen, 0, 2);
    } else if (typeof ctx.createScriptProcessor !== 'undefined') {
        node = ctx.createScriptProcessor(bufferlen, 0, 2);
    }
    
    sidcore = new LibJssidLight();
    sidcore.init(ctx.sampleRate, 6581);
    
    node.onaudioprocess = function(e) {
        sidcore.render(e.outputBuffer, bufferlen);
    };
    
    function play() {
        if(!filedata || isConn) return;
        node.connect(ctx.destination);
        isConn = true;
    }
    function pause() {
        if (isConn) node.disconnect(ctx.destination);
    }
    function load(_sidurl, _subt) {
        subtune = _subt;
        if (!_sidurl && filedata) {
            sidcore.load(filedata, _subt);
        } else {
            this.pause();
            var req = new XMLHttpRequest();
            req.open('GET', _sidurl, true);
            req.responseType = 'arraybuffer';

            var _play = this.play;
            req.onreadystatechange = function() {
                if (req.readyState !== 4) return;
                if (req.status < 200 || req.status >= 300) return;
                filedata = new Uint8Array(req.response);
                if (sidcore.load(filedata, _subt)) _play();
            };
            req.send(null);
        }
    }
    
    
    function LibJssidLight() {
        this.init   = libcsid_init;
        this.load   = libcsid_load;
        this.render = libcsid_render;
        
        // Based of cSID light - an attempt at a usable simple API
        // JS re-port by pachuco(in progress)

        // cSID by Hermit (Mihaly Horvath), (Year 2017) http://hermit.sidrip.com
        // (based on jsSID, this version has much lower CPU-usage, as mainloop runs at samplerate)
        // License: WTF - Do what the fuck you want with this code, but please mention me as its original author.
        
        //global constants and variables
        var SIDMODEL_8580 = 8580;
        var SIDMODEL_6581 = 6581;
        var DEFAULT_SIDMODEL = SIDMODEL_6581;
        
        var C64_PAL_CPUCLK         = 985248.0;
        var SID_CHANNEL_AMOUNT     = 3;
        var MAX_FILENAME_LEN       = 512;
        var MAX_DATA_LEN           = 65536;
        var PAL_FRAMERATE          = 50.06;   //50.0443427 //50.1245419 //(C64_PAL_CPUCLK/63/312.5), selected carefully otherwise some ADSR-sensitive tunes may suffer more:
        var DEFAULT_SAMPLERATE     = 44100.0; //(Soldier of Fortune, 2nd Reality, Alliance, X-tra energy, Jackal, Sanxion, Ultravox, Hard Track, Swing, Myth, LN3, etc.)
        var CLOCK_RATIO_DEFAULT    = C64_PAL_CPUCLK/DEFAULT_SAMPLERATE; //(50.0567520: lowest framerate where Sanxion is fine, and highest where Myth is almost fine)
        var VCR_SHUNT_6581         = 1500;    //kOhm //cca 1.5 MOhm Rshunt across VCR FET drain and source (causing 220Hz bottom cutoff with 470pF integrator capacitors in old C64)
        var VCR_FET_TRESHOLD       = 192;     //Vth (on cutoff numeric range 0..2048) for the VCR cutoff-frequency control FET below which it doesn't conduct
        var CAP_6581               = 0.470;   //nF //filter capacitor value for 6581
        var FILTER_DARKNESS_6581   = 22.0;    //the bigger the value, the darker the filter control is (that is, cutoff frequency increases less with the same cutoff-value)
        var FILTER_DISTORTION_6581 = 0.0016;  //the bigger the value the more of resistance-modulation (filter distortion) is applied for 6581 cutoff-control
        
        var OUTPUT_SCALEDOWN = SID_CHANNEL_AMOUNT * 16 + 26; 
        //raw output divided by this after multiplied by main volume, this also compensates for filter-resonance emphasis to avoid distotion
        
        var GATE_BITMASK=0x01, SYNC_BITMASK=0x02, RING_BITMASK=0x04, TEST_BITMASK=0x08; 
        var TRI_BITMASK=0x10, SAW_BITMASK=0x20, PULSE_BITMASK=0x40, NOISE_BITMASK=0x80;
        var HOLDZERO_BITMASK=0x10, DECAYSUSTAIN_BITMASK=0x40, ATTACK_BITMASK=0x80; 
        var LOWPASS_BITMASK=0x10, BANDPASS_BITMASK=0x20, HIGHPASS_BITMASK=0x40, OFF3_BITMASK=0x80;
        
        var clock_ratio=CLOCK_RATIO_DEFAULT;
        
        //SID-emulation variables:
        var FILTSW = [1,2,4,1,2,4,1,2,4];
        var ADSRstate = [0,0,0,0,0,0,0,0,0];
        var expcnt = [0,0,0,0,0,0,0,0,0];
        var prevSR = [0,0,0,0,0,0,0,0,0];
        var sourceMSBrise = [0,0,0,0,0,0,0,0,0];
        var envcnt = [0,0,0,0,0,0,0,0,0];
        var prevwfout = [0,0,0,0,0,0,0,0,0];
        var prevwavdata = [0,0,0,0,0,0,0,0,0];
        var sourceMSB = [0,0,0];
        var noise_LFSR = [0,0,0,0,0,0,0,0,0];
        var phaseaccu = [0,0,0,0,0,0,0,0,0];
        var prevaccu = [0,0,0,0,0,0,0,0,0];
        var prevlowpass = [0,0,0];
        var prevbandpass = [0,0,0];
        var ratecnt = [0,0,0,0,0,0,0,0,0];
        var cutoff_ratio_8580, cutoff_steepness_6581, cap_6581_reciprocal;
        //, cutoff_ratio_6581, cutoff_bottom_6581, cutoff_top_6581;
        
        //player-related variables:
        var SIDamount=1; var SID_model=[8580,8580,8580]; var requested_SID_model=-1;
        var sampleratio;
        var filedata;
        var memory = new Uint8Array(MAX_DATA_LEN);
        var timermode = new Uint8Array(0x20);
        var SIDtitle = new Uint8Array(0x20);
        var SIDauthor = new Uint8Array(0x20);
        var SIDinfo = new Uint8Array(0x20);
        
        var subtune=0, tunelength=-1, default_tunelength=300, minutes=-1, seconds=-1;
        var initaddr, playaddr, playaddf, SID_address = [0xD400,0,0];
        var samplerate = DEFAULT_SAMPLERATE;
        var framecnt=0, frame_sampleperiod = DEFAULT_SAMPLERATE/PAL_FRAMERATE;
        //CPU (and CIA/VIC-IRQ) emulation constants and variables - avoiding internal/automatic variables to retain speed
        var flagsw=[0x01,0x21,0x04,0x24,0x00,0x40,0x08,0x28], branchflag=[0x80,0x40,0x01,0x02];
        var PC=0, pPC=0, addr=0, storadd=0;
        var A=0, T=0, SP=0xFF; 
        var X=0, Y=0, IR=0, ST=0x00;  //STATUS-flags: N V - B D I Z C
        var CPUtime=0.0;
        var cycles=0, finished=0, dynCIA=0;
        
        //----------------------------- MAIN thread ----------------------------
        
        
        function init(subt) {
            var timeout;
            subtune = subt; initCPU(initaddr); initSID(); A=subtune; memory[1]=0x37; memory[0xDC05]=0;
            for(timeout=100000;timeout>=0;timeout--) { if (CPU()) break; } 
            if (timermode[subtune] || memory[0xDC05]) { //&& playaddf {   //CIA timing
                if (!memory[0xDC05]) {memory[0xDC04]=0x24; memory[0xDC05]=0x40;} //C64 startup-default
                frame_sampleperiod = (memory[0xDC04]+memory[0xDC05]*256)/clock_ratio;
            } else frame_sampleperiod = samplerate/PAL_FRAMERATE;  //Vsync timing
            console.log("Frame-sampleperiod: "+Math.round(frame_sampleperiod)+" samples  ("+samplerate/PAL_FRAMERATE/frame_sampleperiod+" speed)");
            //frame_sampleperiod = (memory[0xDC05]!=0 || (!timermode[subtune] && playaddf))? samplerate/PAL_FRAMERATE : (memory[0xDC04] + memory[0xDC05]*256) / clock_ratio; 
            if(playaddf==0) { playaddr = ((memory[1]&3)<2)? memory[0xFFFE]+memory[0xFFFF]*256 : memory[0x314]+memory[0x315]*256; console.log("IRQ-playaddress:"+playaddr); }
            else { playaddr=playaddf; if (playaddr>=0xE000 && memory[1]==0x37) memory[1]=0x35; } //player under KERNAL (Crystal Kingdom Dizzy)
            initCPU(playaddr); framecnt=1; finished=0; CPUtime=0; 
        }
        
        function play(userdata, stream, len) { //called by SDL at samplerate pace
            var i,j, output;
            for(i=0;i<len;i+=2) {
                framecnt--; if (framecnt<=0) { framecnt=frame_sampleperiod; finished=0; PC=playaddr; SP=0xFF; } // printf("%d  %f\n",framecnt,playtime); }
                if (finished==0) { 
                    while (CPUtime<=clock_ratio) {
                        pPC=PC; if (CPU()>=0xFE || ( (memory[1]&3)>1 && pPC<0xE000 && (PC==0xEA31 || PC==0xEA81) ) ) {finished=1;break;} else CPUtime+=cycles; //RTS,RTI and IRQ player ROM return handling
                        if ( (addr==0xDC05 || addr==0xDC04) && (memory[1]&3) && timermode[subtune] ) {
                            frame_sampleperiod = (memory[0xDC04] + memory[0xDC05]*256) / clock_ratio;  //dynamic CIA-setting (Galway/Rubicon workaround)
                            if (!dynCIA) {dynCIA=1; console.log("( Dynamic CIA settings. New frame-sampleperiod: "+Math.round(frame_sampleperiod)+" samples  ("+samplerate/PAL_FRAMERATE/frame_sampleperiod+" speed) )\n");}
                        }
                        if(storadd>=0xD420 && storadd<0xD800 && (memory[1]&3)) {  //CJ in the USA workaround (writing above $d420, except SID2/SID3)
                            if ( !(SID_address[1]<=storadd && storadd<SID_address[1]+0x1F) && !(SID_address[2]<=storadd && storadd<SID_address[2]+0x1F) )
                            memory[storadd&0xD41F]=memory[storadd]; //write to $D400..D41F if not in SID2/SID3 address-space
                        }
                        if(addr==0xD404 && !(memory[0xD404]&GATE_BITMASK)) ADSRstate[0]&=0x3E; //Whittaker player workarounds (if GATE-bit triggered too fast, 0 for some cycles then 1)
                        if(addr==0xD40B && !(memory[0xD40B]&GATE_BITMASK)) ADSRstate[1]&=0x3E;
                        if(addr==0xD412 && !(memory[0xD412]&GATE_BITMASK)) ADSRstate[2]&=0x3E;
                    }
                    CPUtime-=clock_ratio;
                }
                output = SID(0,0xD400);
                if (SIDamount>=2) output += SID(1,SID_address[1]); 
                if (SIDamount==3) output += SID(2,SID_address[2]); 
                stream[i]=output&0xFF; stream[i+1]=output>>8;
            }
        }
        
        
        //--------------------------------- CPU emulation -------------------------------------------
        void initCPU(mempos) { PC=mempos; A=0; X=0; Y=0; ST=0; SP=0xFF; } 
        
        //My CPU implementation is based on the instruction table by Graham at codebase64.
        //After some examination of the table it was clearly seen that columns of the table (instructions' 2nd nybbles)
        // mainly correspond to addressing modes, and double-rows usually have the same instructions.
        //The code below is laid out like this, with some exceptions present.
        //Thanks to the hardware being in my mind when coding this, the illegal instructions could be added fairly easily...
        byte CPU() { //the CPU emulation for SID/PRG playback (ToDo: CIA/VIC-IRQ/NMI/RESET vectors, BCD-mode)
            //'IR' is the instruction-register, naming after the hardware-equivalent
            IR=memory[PC]; cycles=2; storadd=0; //'cycle': ensure smallest 6510 runtime (for implied/register instructions)
            if(IR&1) {  //nybble2:  1/5/9/D:accu.instructions, 3/7/B/F:illegal opcodes
                switch (IR&0x1F) { //addressing modes (begin with more complex cases), PC wraparound not handled inside to save codespace
                    case 1: case 3: PC++; addr = memory[memory[PC]+X] + memory[memory[PC]+X+1]*256; cycles=6; break; //(zp,x)
                    case 0x11: case 0x13: PC++; addr = memory[memory[PC]] + memory[memory[PC]+1]*256 + Y; cycles=6; break; //(zp),y (5..6 cycles, 8 for R-M-W)
                    case 0x19: case 0x1B: PC++; addr=memory[PC]; PC++; addr+=memory[PC]*256 + Y; cycles=5; break; //abs,y //(4..5 cycles, 7 cycles for R-M-W)
                    case 0x1D: PC++; addr=memory[PC]; PC++; addr+=memory[PC]*256 + X; cycles=5; break; //abs,x //(4..5 cycles, 7 cycles for R-M-W)
                    case 0xD: case 0xF: PC++; addr=memory[PC]; PC++; addr+=memory[PC]*256; cycles=4; break; //abs
                    case 0x15: PC++; addr = memory[PC] + X; cycles=4; break; //zp,x
                    case 5: case 7: PC++; addr = memory[PC]; cycles=3; break; //zp
                    case 0x17: PC++; if ((IR&0xC0)!=0x80) { addr = memory[PC] + X; cycles=4; } //zp,x for illegal opcodes
                            else { addr = memory[PC] + Y; cycles=4; }  break; //zp,y for LAX/SAX illegal opcodes
                    case 0x1F: PC++; if ((IR&0xC0)!=0x80) { addr = memory[PC] + memory[++PC]*256 + X; cycles=5; } //abs,x for illegal opcodes
                            else { addr = memory[PC] + memory[++PC]*256 + Y; cycles=5; }  break; //abs,y for LAX/SAX illegal opcodes
                    case 9: case 0xB: PC++; addr = PC; cycles=2;  //immediate
                }
                addr&=0xFFFF;
                switch (IR&0xE0) {
                    case 0x60: if ((IR&0x1F)!=0xB) { if((IR&3)==3) {T=(memory[addr]>>1)+(ST&1)*128; ST&=124; ST|=(T&1); memory[addr]=T; cycles+=2;}   //ADC / RRA (ROR+ADC)
                                T=A; A+=memory[addr]+(ST&1); ST&=60; ST|=(A&128)|(A>255); A&=0xFF; ST |= (!A)<<1 | ( !((T^memory[addr])&0x80) & ((T^A)&0x80) ) >> 1; }
                            else { A&=memory[addr]; T+=memory[addr]+(ST&1); ST&=60; ST |= (T>255) | ( !((A^memory[addr])&0x80) & ((T^A)&0x80) ) >> 1; //V-flag set by intermediate ADC mechanism: (A&mem)+mem
                                T=A; A=(A>>1)+(ST&1)*128; ST|=(A&128)|(T>127); ST|=(!A)<<1; }  break; // ARR (AND+ROR, bit0 not going to C, but C and bit7 get exchanged.)
                    case 0xE0: if((IR&3)==3 && (IR&0x1F)!=0xB) {memory[addr]++;cycles+=2;}  T=A; A-=memory[addr]+!(ST&1); //SBC / ISC(ISB)=INC+SBC
                            ST&=60; ST|=(A&128)|(A>=0); A&=0xFF; ST |= (!A)<<1 | ( ((T^memory[addr])&0x80) & ((T^A)&0x80) ) >> 1; break; 
                    case 0xC0: if((IR&0x1F)!=0xB) { if ((IR&3)==3) {memory[addr]--; cycles+=2;}  T=A-memory[addr]; } // CMP / DCP(DEC+CMP)
                            else {X=T=(A&X)-memory[addr];} /*SBX(AXS)*/  ST&=124;ST|=(!(T&0xFF))<<1|(T&128)|(T>=0);  break;  //SBX (AXS) (CMP+DEX at the same time)
                    case 0x00: if ((IR&0x1F)!=0xB) { if ((IR&3)==3) {ST&=124; ST|=(memory[addr]>127); memory[addr]<<=1; cycles+=2;}  
                                A|=memory[addr]; ST&=125;ST|=(!A)<<1|(A&128); } //ORA / SLO(ASO)=ASL+ORA
                            else {A&=memory[addr]; ST&=124;ST|=(!A)<<1|(A&128)|(A>127);}  break; //ANC (AND+Carry=bit7)
                    case 0x20: if ((IR&0x1F)!=0xB) { if ((IR&3)==3) {T=(memory[addr]<<1)+(ST&1); ST&=124; ST|=(T>255); T&=0xFF; memory[addr]=T; cycles+=2;}  
                                A&=memory[addr]; ST&=125; ST|=(!A)<<1|(A&128); }  //AND / RLA (ROL+AND)
                            else {A&=memory[addr]; ST&=124;ST|=(!A)<<1|(A&128)|(A>127);}  break; //ANC (AND+Carry=bit7)
                    case 0x40: if ((IR&0x1F)!=0xB) { if ((IR&3)==3) {ST&=124; ST|=(memory[addr]&1); memory[addr]>>=1; cycles+=2;}
                                A^=memory[addr]; ST&=125;ST|=(!A)<<1|(A&128); } //EOR / SRE(LSE)=LSR+EOR
                                else {A&=memory[addr]; ST&=124; ST|=(A&1); A>>=1; A&=0xFF; ST|=(A&128)|((!A)<<1); }  break; //ALR(ASR)=(AND+LSR)
                    case 0xA0: if ((IR&0x1F)!=0x1B) { A=memory[addr]; if((IR&3)==3) X=A; } //LDA / LAX (illegal, used by my 1 rasterline player) 
                            else {A=X=SP=memory[addr]&SP;} /*LAS(LAR)*/  ST&=125; ST|=((!A)<<1) | (A&128); break;  // LAS (LAR)
                    case 0x80: if ((IR&0x1F)==0xB) { A = X & memory[addr]; ST&=125; ST|=(A&128) | ((!A)<<1); } //XAA (TXA+AND), highly unstable on real 6502!
                            else if ((IR&0x1F)==0x1B) { SP=A&X; memory[addr]=SP&((addr>>8)+1); } //TAS(SHS) (SP=A&X, mem=S&H} - unstable on real 6502
                            else {memory[addr]=A & (((IR&3)==3)?X:0xFF); storadd=addr;}  break; //STA / SAX (at times same as AHX/SHX/SHY) (illegal) 
                }
            } else if(IR&2) {  //nybble2:  2:illegal/LDX, 6:A/X/INC/DEC, A:Accu-shift/reg.transfer/NOP, E:shift/X/INC/DEC
                switch (IR&0x1F) { //addressing modes
                    case 0x1E: PC++; addr=memory[PC]; PC++; addr+=memory[PC]*256 + ( ((IR&0xC0)!=0x80) ? X:Y ); cycles=5; break; //abs,x / abs,y
                    case 0xE: PC++; addr=memory[PC]; PC++; addr+=memory[PC]*256; cycles=4; break; //abs
                    case 0x16: PC++; addr = memory[PC] + ( ((IR&0xC0)!=0x80) ? X:Y ); cycles=4; break; //zp,x / zp,y
                    case 6: PC++; addr = memory[PC]; cycles=3; break; //zp
                    case 2: PC++; addr = PC; cycles=2;  //imm.
                }  
                addr&=0xFFFF;
                switch (IR&0xE0) {
                    case 0x00: ST&=0xFE; case 0x20: if((IR&0xF)==0xA) { A=(A<<1)+(ST&1); ST&=124;ST|=(A&128)|(A>255); A&=0xFF; ST|=(!A)<<1; } //ASL/ROL (Accu)
                    else { T=(memory[addr]<<1)+(ST&1); ST&=124;ST|=(T&128)|(T>255); T&=0xFF; ST|=(!T)<<1; memory[addr]=T; cycles+=2; }  break; //RMW (Read-Write-Modify)
                    case 0x40: ST&=0xFE; case 0x60: if((IR&0xF)==0xA) { T=A; A=(A>>1)+(ST&1)*128; ST&=124;ST|=(A&128)|(T&1); A&=0xFF; ST|=(!A)<<1; } //LSR/ROR (Accu)
                    else { T=(memory[addr]>>1)+(ST&1)*128; ST&=124;ST|=(T&128)|(memory[addr]&1); T&=0xFF; ST|=(!T)<<1; memory[addr]=T; cycles+=2; }  break; //memory (RMW)
                    case 0xC0: if(IR&4) { memory[addr]--; ST&=125;ST|=(!memory[addr])<<1|(memory[addr]&128); cycles+=2; } //DEC
                    else {X--; X&=0xFF; ST&=125;ST|=(!X)<<1|(X&128);}  break; //DEX
                    case 0xA0: if((IR&0xF)!=0xA) X=memory[addr];  else if(IR&0x10) {X=SP;break;}  else X=A;  ST&=125;ST|=(!X)<<1|(X&128);  break; //LDX/TSX/TAX
                    case 0x80: if(IR&4) {memory[addr]=X;storadd=addr;}  else if(IR&0x10) SP=X;  else {A=X; ST&=125;ST|=(!A)<<1|(A&128);}  break; //STX/TXS/TXA
                    case 0xE0: if(IR&4) { memory[addr]++; ST&=125;ST|=(!memory[addr])<<1|(memory[addr]&128); cycles+=2; } //INC/NOP
                }
            } else if((IR&0xC)==8) {  //nybble2:  8:register/status
                switch (IR&0xF0) {
                    case 0x60: SP++; SP&=0xFF; A=memory[0x100+SP]; ST&=125;ST|=(!A)<<1|(A&128); cycles=4; break; //PLA
                    case 0xC0: Y++; Y&=0xFF; ST&=125;ST|=(!Y)<<1|(Y&128); break; //INY
                    case 0xE0: X++; X&=0xFF; ST&=125;ST|=(!X)<<1|(X&128); break; //INX
                    case 0x80: Y--; Y&=0xFF; ST&=125;ST|=(!Y)<<1|(Y&128); break; //DEY
                    case 0x00: memory[0x100+SP]=ST; SP--; SP&=0xFF; cycles=3; break; //PHP
                    case 0x20: SP++; SP&=0xFF; ST=memory[0x100+SP]; cycles=4; break; //PLP
                    case 0x40: memory[0x100+SP]=A; SP--; SP&=0xFF; cycles=3; break; //PHA
                    case 0x90: A=Y; ST&=125;ST|=(!A)<<1|(A&128); break; //TYA
                    case 0xA0: Y=A; ST&=125;ST|=(!Y)<<1|(Y&128); break; //TAY
                    default: if(flagsw[IR>>5]&0x20) ST|=(flagsw[IR>>5]&0xDF); else ST&=255-(flagsw[IR>>5]&0xDF);  //CLC/SEC/CLI/SEI/CLV/CLD/SED
                }
            } else {  //nybble2:  0: control/branch/Y/compare  4: Y/compare  C:Y/compare/JMP
                if ((IR&0x1F)==0x10) { PC++; T=memory[PC]; if(T&0x80) T-=0x100; //BPL/BMI/BVC/BVS/BCC/BCS/BNE/BEQ  relative branch 
                    if(IR&0x20) {if (ST&branchflag[IR>>6]) {PC+=T;cycles=3;}} else {if (!(ST&branchflag[IR>>6])) {PC+=T;cycles=3;}}
                } else {  //nybble2:  0:Y/control/Y/compare  4:Y/compare  C:Y/compare/JMP
                    switch (IR&0x1F) { //addressing modes
                    case 0: PC++; addr = PC; cycles=2; break; //imm. (or abs.low for JSR/BRK)
                    case 0x1C: PC++; addr=memory[PC]; PC++; addr+=memory[PC]*256 + X; cycles=5; break; //abs,x
                    case 0xC: PC++; addr=memory[PC]; PC++; addr+=memory[PC]*256; cycles=4; break; //abs
                    case 0x14: PC++; addr = memory[PC] + X; cycles=4; break; //zp,x
                    case 4: PC++; addr = memory[PC]; cycles=3;  //zp
                    }  
                    addr&=0xFFFF;  
                    switch (IR&0xE0) {
                    case 0x00: memory[0x100+SP]=PC%256; SP--;SP&=0xFF; memory[0x100+SP]=PC/256;  SP--;SP&=0xFF; memory[0x100+SP]=ST; SP--;SP&=0xFF; 
                    PC = memory[0xFFFE]+memory[0xFFFF]*256-1; cycles=7; break; //BRK
                    case 0x20: if(IR&0xF) { ST &= 0x3D; ST |= (memory[addr]&0xC0) | ( !(A&memory[addr]) )<<1; } //BIT
                    else { memory[0x100+SP]=(PC+2)%256; SP--;SP&=0xFF; memory[0x100+SP]=(PC+2)/256;  SP--;SP&=0xFF; PC=memory[addr]+memory[addr+1]*256-1; cycles=6; }  break; //JSR
                    case 0x40: if(IR&0xF) { PC = addr-1; cycles=3; } //JMP
                    else { if(SP>=0xFF) return 0xFE; SP++;SP&=0xFF; ST=memory[0x100+SP]; SP++;SP&=0xFF; T=memory[0x100+SP]; SP++;SP&=0xFF; PC=memory[0x100+SP]+T*256-1; cycles=6; }  break; //RTI
                    case 0x60: if(IR&0xF) { PC = memory[addr]+memory[addr+1]*256-1; cycles=5; } //JMP() (indirect)
                    else { if(SP>=0xFF) return 0xFF; SP++;SP&=0xFF; T=memory[0x100+SP]; SP++;SP&=0xFF; PC=memory[0x100+SP]+T*256-1; cycles=6; }  break; //RTS
                    case 0xC0: T=Y-memory[addr]; ST&=124;ST|=(!(T&0xFF))<<1|(T&128)|(T>=0); break; //CPY
                    case 0xE0: T=X-memory[addr]; ST&=124;ST|=(!(T&0xFF))<<1|(T&128)|(T>=0); break; //CPX
                    case 0xA0: Y=memory[addr]; ST&=125;ST|=(!Y)<<1|(Y&128); break; //LDY
                    case 0x80: memory[addr]=Y; storadd=addr;  //STY
                    }
                }
            }
            PC++; //PC&=0xFFFF; 
            return 0; 
        }
        
        
        function libcsid_init(_samplerate, _sidmodel) {
            samplerate = _samplerate;
        }
        
        function libcsid_load(_buffer, _subtune) {
            var bufferlen = _buffer.length;
            if (bufferlen > MAX_DATA_LEN) return 0;
            filedata = _buffer;
        }
        
        function libcsid_render(_output, _numsamples) {
            var out0 = _output.getChannelData(0);
            var out1 = _output.getChannelData(1);
            for(var i=0; i<_numsamples; i++) {
                out0[i] = 0;
                out1[i] = 0;
            }
        }
    }
}