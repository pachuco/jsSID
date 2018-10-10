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
        this.init   = init;
        this.load   = load;
        this.render = render;
        
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
        
        function init(_samplerate, _sidmodel) {
            samplerate = _samplerate;
        }
        
        function load(_buffer, _subtune) {
            var bufferlen = _buffer.length;
            if (bufferlen > MAX_DATA_LEN) return 0;
            filedata = _buffer;
        }
        
        function render(_output, _numsamples) {
            var out0 = _output.getChannelData(0);
            var out1 = _output.getChannelData(1);
            for(var i=0; i<_numsamples; i++) {
                out0[i] = 0;
                out1[i] = 0;
            }
        }
    }
}