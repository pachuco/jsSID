"use strict";
function jsSID(_bufferlen) {
    this.play = play;
    this.pause = pause;
    this.load = load;
    
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
                sidcore.load(filedata, _subt);
                _play();
            }
            req.send(null);
        }
    }
    
    
    function LibJssidLight() {
        this.init = init;
        this.load = load;
        this.render = render;
        
        var samplerate;
        
        function init(_samplerate, _sidmodel) {
            samplerate = _samplerate;
        }
        
        function load(_buffer, _subtune) {
            var bufferlen = _buffer.length;
        }
        
        var sawfreq = 500; var phase0 = 0; var phase1 = 0; var amp = 0.3;
        function render(_output, _numsamples) {
            //test render
            var sawincr = sawfreq / samplerate;
            var out0 = _output.getChannelData(0);
            var out1 = _output.getChannelData(1);
            for(var i=0; i<_numsamples; i++) {
                out0[i] = (phase0 * 2 - 1) * amp;
                out1[i] = (phase1 * 2 - 1) * amp;
                phase0 = (phase0 + sawincr) % 1;
                phase1 = ((phase1 + sawincr + sawincr / 5000) % 1);
            }
        }
    }
}