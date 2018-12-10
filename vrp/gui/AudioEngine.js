var clamp = function(val, min, max){ return Math.min(Math.max(min, val), max); }

var is_playing = function(media)
{
  return media.currentTime > 0 && !media.paused && !media.ended && media.readyState > 2;
}

function AudioEngine()
{
  var _this = this;

  this.c = new AudioContext();
  //choose processor buffer size (2^(8-14))
  this.processor_buffer_size = Math.pow(2, clamp(Math.floor(Math.log(this.c.sampleRate*0.1)/Math.log(2)), 8, 14));

  this.sources = {};
  this.player_sources = {};
  this.listener = this.c.listener;

  this.last_check = new Date().getTime();

  //VoIP
  this.voice_indicator_div = document.createElement("div");
  this.voice_indicator_div.id = "voice_indicator";
  document.body.appendChild(this.voice_indicator_div);

  this.voice_channels = {}; // map of idx => channel 

  libopus.onload = function(){
    //encoder
    _this.mic_enc = new libopus.Encoder(1,48000,24000,true);
  }
  if(libopus.loaded) //force loading if already loaded
    libopus.onload();

  //processor
  //prepare process function
  var processOut = function(peers, samples){
    //convert to Int16 pcm
    var isamples = new Int16Array(samples.length);
    for(var i = 0; i < samples.length; i++){
      var s = samples[i];
      s *= 32768 ;
      if(s > 32767) 
        s = 32767;
      else if(s < -32768) 
        s = -32768;

      isamples[i] = s;
    }

    //encode
    _this.mic_enc.input(isamples);
    var data;
    while(data = _this.mic_enc.output()){ //generate packets
      var buffer = data.slice().buffer;

      //send packet to active/connected peers
      for(var i = 0; i < peers.length; i++){
        try{
          peers[i].data_channel.send(buffer);
        }catch(e){
          console.log("vRP-VoIP send error to player "+peers[i].player);
        }
      }
    }
  }


  this.mic_processor = this.c.createScriptProcessor(this.processor_buffer_size,1,1);
  this.mic_processor.onaudioprocess = function(e){
    var buffer = e.inputBuffer;

    var peers = [];
    //prepare list of active/connected peers
    for(var nchannel in _this.voice_channels){
      var channel = _this.voice_channels[nchannel];
      for(var player in channel){
        if(player != "_config"){
          var peer = channel[player];
          if(peer.connected && peer.active)
            peers.push(peer);
        }
      }
    }

    if(peers.length > 0){
      //resample to 48kHz if necessary
      if(buffer.sampleRate != 48000){
        var ratio = 48000/buffer.sampleRate;
        var oac = new OfflineAudioContext(1,Math.floor(ratio*buffer.length),48000);
        var sbuff = oac.createBufferSource();
        sbuff.buffer = buffer;
        sbuff.connect(oac.destination);
        sbuff.start();

        oac.startRendering().then(function(out_buffer){
          processOut(peers, out_buffer.getChannelData(0));
        });
      }
      else 
        processOut(peers, buffer.getChannelData(0)); 
    }

    //silent output
    var out = e.outputBuffer.getChannelData(0);
    for(var k = 0; k < out.length; k++)
      out[k] = 0;
  }

  this.mic_processor.connect(this.c.destination); //make the processor running

  //mic stream
  navigator.mediaDevices.getUserMedia({
    audio: {
      autoGainControl: false,
      echoCancellation: false,
      noiseSuppression: false,
      latency: 0
    }
  }).then(function(stream){ 
    _this.mic_node = _this.c.createMediaStreamSource(stream);
    _this.mic_comp = _this.c.createDynamicsCompressor();
    _this.mic_node.connect(_this.mic_comp);
    _this.mic_comp.connect(_this.mic_processor);
    //_this.mic_comp.connect(_this.c.destination);
  });

  this.player_positions = {};
}

AudioEngine.prototype.setListenerData = function(data)
{
  this.listener.pos = [data.x, data.y, data.z];
  this.listener.setPosition(data.x, data.y, data.z);
  this.listener.setOrientation(data.fx,data.fy,data.fz,0,0,1);

  var time = new Date().getTime();
  if(time-this.last_check >= 2000){ // every 2s
    this.last_check = time;

    // pause too far away sources and unpause nearest sources paused
    for(var name in this.sources){
      var source = this.sources[name];

      if(source[3]){ //spatialized
        var dx = data.x-source[2].pos[0];
        var dy = data.y-source[2].pos[1];
        var dz = data.z-source[2].pos[2];
        var dist = Math.sqrt(dx*dx+dy*dy+dz*dz);
        var active_dist = source[2].maxDistance*2;

        if(!is_playing(source[0]) && dist <= active_dist)
          source[0].play();
        else if(is_playing(source[0]) && dist > active_dist)
          source[0].pause();
      }
    }
  }
}

// return [audio, node, panner]
AudioEngine.prototype.setupAudioSource = function(data)
{
  var audio = new Audio();
  audio.src = data.url;
  audio.volume = data.volume;

  var spatialized = (data.x != null && data.y != null && data.z != null && data.max_dist != null);
  var node = null;
  var panner = null;

  if(spatialized){
    node = this.c.createMediaElementSource(audio);

    panner = this.c.createPanner();
//    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = 1;
    panner.maxDistance = data.max_dist;
    panner.rolloffFactor = 1;
    panner.coneInnerAngle = 360;
    panner.coneOuterAngle = 0;
    panner.coneOuterGain = 0;

    var ppos = null;
    if(data.player != null)
      ppos = this.player_positions[data.player];
    if(ppos){
      panner.pos = [ppos[0]+data.x, ppos[1]+data.y, ppos[2]+data.z];
      panner.setPosition(ppos[0]+data.x, ppos[1]+data.y, ppos[2]+data.z);
    }
    else{
      panner.pos = [data.x, data.y, data.z];
      panner.setPosition(data.x, data.y, data.z);
    }

    node.connect(panner);
    panner.connect(this.c.destination);
  }

  return [audio, node, panner, spatialized, data];
}

AudioEngine.prototype.bindPlayerSource = function(source)
{
  var player = source[4].player;
  if(player != null){
    var sources = this.player_sources[player];
    if(sources == null){
      sources = [];
      this.player_sources[player] = sources;
    }

    sources.push(source);
  }
}

AudioEngine.prototype.unbindPlayerSource = function(source)
{
  var player = source[4].player;
  if(player != null){
    var sources = this.player_sources[player];
    if(sources != null){
      var idx = sources.indexOf(source);
      if(idx >= 0)
        sources.splice(idx, 1);

      if(sources.length <= 0)
        delete this.player_sources[player];
    }
  }
}

AudioEngine.prototype.playAudioSource = function(data)
{
  var _this = this;

  var source = this.setupAudioSource(data);
  var spatialized = source[3];
  var dist = 10;
  var active_dist = 0;

  if(spatialized){
    var dx = this.listener.pos[0]-source[2].pos[0];
    var dy = this.listener.pos[1]-source[2].pos[1];
    var dz = this.listener.pos[2]-source[2].pos[2];
    dist = Math.sqrt(dx*dx+dy*dy+dz*dz);
    active_dist = source[2].maxDistance*2;
  }

  if(!spatialized || dist <= active_dist){ //valid to play
    if(spatialized){
      // bind deleter
      this.bindPlayerSource(source);
      source[0].onended = function(){
        _this.unbindPlayerSource(source);
        source[2].disconnect(_this.c.destination);
      }
    }

    // play
    source[0].play();
  }
}

AudioEngine.prototype.setAudioSource = function(data)
{
  this.removeAudioSource(data);

  var source = this.setupAudioSource(data);
  this.bindPlayerSource(source);

  var spatialized = source[3];

  source[0].loop = true;
  this.sources[data.name] = source;


  // play
  var dist = 10;
  var active_dist = 0;
  if(spatialized){
    var dx = this.listener.pos[0]-source[2].pos[0];
    var dy = this.listener.pos[1]-source[2].pos[1];
    var dz = this.listener.pos[2]-source[2].pos[2];
    dist = Math.sqrt(dx*dx+dy*dy+dz*dz);
    active_dist = source[2].maxDistance*2;
  }

  if(!spatialized || dist <= active_dist)
    source[0].play();
}

AudioEngine.prototype.removeAudioSource = function(data)
{
  var source = this.sources[data.name];
  if(source){
    this.unbindPlayerSource(source);

    delete this.sources[data.name];
    source[0].src = "";
    source[0].loop = false;
    if(is_playing(source[0]))
      source[0].pause();
    if(source[3]) //spatialized
      source[2].disconnect(this.c.destination);
  }
}

//VoIP

AudioEngine.prototype.configureVoIP = function(data)
{
  var _this = this;

  this.voip_config = data.config;

  // create channels
  for(var id in this.voip_config.channels){
    var cdata = this.voip_config.channels[id];

    var idx = cdata[0];
    var config = cdata[1];

    // create channel
    var channel = {index: idx, id: id, players: {}};
    this.voice_channels[idx] = channel;

    // build channel effects
    var effects = config.effects || {};
    var node = null;

    if(effects.biquad){ //biquad filter
      var biquad = this.c.createBiquadFilter();
      if(effects.biquad.frequency != null)
        biquad.frequency.value = effects.biquad.frequency;
      if(effects.biquad.Q != null)
        biquad.Q.value = effects.biquad.Q;
      if(effects.biquad.detune != null)
        biquad.detune.value = effects.biquad.detune;
      if(effects.biquad.gain != null)
        biquad.gain.value = effects.biquad.gain;

      if(effects.biquad.type != null)
        biquad.type = effects.biquad.type;

      if(node)
        node.connect(biquad);
      node = biquad;
      if(!channel.in_node)
        channel.in_node = node;
    }

    if(effects.gain){ //gain
      var gain = this.c.createGain();
      if(effects.gain.gain != null)
        gain.gain.value = effects.gain.gain;

      if(node)
        node.connect(gain);
      node = gain;
      if(!channel.in_node)
        channel.in_node = node;
    }

    //connect final node to output
    if(node) 
      node.connect(this.c.destination);
  }

  // connect to websocket server
  this.voip_ws = new WebSocket(this.voip_config.server);

  // create peer
  this.voip_peer = new RTCPeerConnection({
    iceServers: []
  });

  this.voip_peer.onicecandidate = function(e){
    console.log(e);
    _this.voip_ws.send(JSON.stringify({act: "candidate", data: e.candidate}));
  }

  // create channel
  this.voip_channel = this.voip_peer.createDataChannel("voip", {
    ordered: false,
    negotiated: true,
    maxRetransmits: 0,
    id: 0
  });

  this.voip_channel.binaryType = "arraybuffer";

  this.voip_channel.onopen = function(){
    console.log("channel ready");
  }

  this.voip_channel.onmessage = function(e){
    var buffer = e.data;
    var view = new DataView(buffer);

    var tplayer = view.getInt32(0);
    var nchannels = view.getUint8(4);
    var channels = new Uint8Array(buffer, 5, nchannels);

    if(peer.dec){
      // decode opus packet
      var raw = new Uint8Array(buffer, 5+nchannels);
      peer.dec.input(raw);
      var data;
      while(data = peer.dec.output()){
        // create buffer from samples
        var buffer = _this.c.createBuffer(1, data.length, 48000);
        var samples = buffer.getChannelData(0);

        for(var k = 0; k < data.length; k++){
          // convert from int16 to float
          var s = data[k];
          s /= 32768 ;
          if(s > 1) 
            s = 1;
          else if(s < -1) 
            s = -1;

          samples[k] = s;
        }

        // resample to AudioContext samplerate if necessary
        if(_this.c.sampleRate != 48000){
          var ratio = _this.c.sampleRate/48000;
          var oac = new OfflineAudioContext(1,Math.floor(ratio*buffer.length),_this.c.sampleRate);
          var sbuff = oac.createBufferSource();
          sbuff.buffer = buffer;
          sbuff.connect(oac.destination);
          sbuff.start();

          oac.startRendering().then(function(out_buffer){
            peer.psamples.push(out_buffer.getChannelData(0));
          });
        }
        else 
          peer.psamples.push(samples);
      }
    }
  }

  this.voip_ws.addEventListener("open", function(){
    console.log("ws connected");
    _this.voip_ws.send(JSON.stringify({act: "identification", id: data.id}));
  });

  this.voip_ws.addEventListener("message", function(e){
    var data = JSON.parse(e.data);
    console.log(data);
    if(data.act == "offer"){
      _this.voip_peer.setRemoteDescription(data.data);
      _this.voip_peer.createAnswer().then(function(answer){
        _this.voip_peer.setLocalDescription(answer);
        _this.voip_ws.send(JSON.stringify({act: "answer", data: answer}));
      });
    }
    else if(data.act == "candidate" && data.data != null)
      _this.voip_peer.addIceCandidate(data.data);
  });
}

AudioEngine.prototype.setPlayerPositions = function(data)
{
  this.player_positions = data.positions;

  //update VoIP panners (spatialization effect)
  for(var idx in this.voice_channels){
    var channel = this.voice_channels[idx];
    for(var player in channel.players){
      var peer = channel.players[player];
      if(peer.panner){
        var pos = data.positions[player];
        if(pos){
          peer.panner.pos = pos;
          peer.panner.setPosition(pos[0], pos[1], pos[2]);
        }
      }
    }
  }

  //update player sources panners
  for(var player in this.player_positions){
    var sources = this.player_sources[player];
    if(sources){
      for(var i = 0; i < sources.length; i++){
        var source = sources[i];
        var panner = source[2];
        if(panner){
          var pos = this.player_positions[player];
          if(pos){
            var data = source[4];
            panner.pos = [pos[0]+data.x, pos[1]+data.y, pos[2]+data.z];
            panner.setPosition(pos[0]+data.x, pos[1]+data.y, pos[2]+data.z);
          }
        }
      }
    }
  }
}

AudioEngine.prototype.setupPeer = function(peer)
{
  var _this = this;

  //decoder
  peer.dec = new libopus.Decoder(1,48000);
  peer.psamples = []; //packets samples
  peer.processor = this.c.createScriptProcessor(this.processor_buffer_size,0,1);
  peer.processor.onaudioprocess = function(e){
    var out = e.outputBuffer.getChannelData(0);

    //feed samples to output
    var nsamples = 0;
    var i = 0;
    while(nsamples < out.length && i < peer.psamples.length){
      var p = peer.psamples[i];
      var take = Math.min(p.length, out.length-nsamples);

      //write packet samples to output
      for(var k = 0; k < take; k++){
        out[nsamples+k] = p[k];
      }

      //advance
      nsamples += take;

      if(take < p.length){ //partial samples
        //add rest packet
        peer.psamples.splice(i+1,0,p.subarray(take));
      }

      i++;
    }

    //remove processed packets
    peer.psamples.splice(0,i);

    //silent last samples
    for(var k = nsamples; k < out.length; k++)
      out[k] = 0;
  }


  //add peer effects
  var node = peer.processor;
  var config = this.voip_config.channels[peer.channel][1];
  var channel = this.voice_channels[this.getChannelIndex(peer.channel)];
  var effects = config.effects || {};

  if(effects.spatialization){ //spatialization
    var panner = this.c.createPanner();
    panner.distanceModel = effects.spatialization.dist_model || "inverse";
    panner.refDistance = 1;
    panner.maxDistance = effects.spatialization.max_dist;
    panner.rolloffFactor = effects.spatialization.rolloff || 1;
    panner.coneInnerAngle = 360;
    panner.coneOuterAngle = 0;
    panner.coneOuterGain = 0;

    var pos = this.player_positions[peer.player];
    if(pos){
      panner.pos = pos;
      panner.setPosition(pos[0],pos[1],pos[2]);
    }

    peer.panner = panner;

    node.connect(panner);
    node = panner;
  }

  //connect final node
  peer.final_node = node;
  node.connect(channel.in_node || this.c.destination); //connect to channel node or destination

}

AudioEngine.prototype.getChannelIndex = function(id)
{
  if(this.voip_config && this.voip_config.channels[id])
    return this.voip_config.channels[id][0];

  return -1;
}

AudioEngine.prototype.connectVoice = function(data)
{
  //close previous peer
  this.disconnectVoice(data);

  var channel = this.voice_channels[this.getChannelIndex(data.channel)];
  if(channel){
    //setup new peer
    var peer = {
      channel: data.channel,
      player: data.player
    }

    channel.players[data.player] = peer;

    this.setupPeer(peer);
  }
}

AudioEngine.prototype.disconnectVoice = function(data)
{
  var channel = this.voice_channels[this.getChannelIndex(data.channel)];
  if(channel){
    var players = [];
    if(data.player != null)
      players.push(data.player);
    else{ //add all players
      for(var player in channel.players)
        players.push(player);
    }

    //remove peers
    for(var i = 0; i < players.length; i++){
      var player = players[i];
      var peer = channel.players[player];
      if(peer){
        if(peer.final_node) //disconnect from channel node or destination
          peer.final_node.disconnect(channel.in_node || this.c.destination);
        if(peer.dec){
          peer.dec.destroy();
          delete peer.dec;
        }
      }

      delete channel.players[player];
    }

    //update indicator
    this.updateVoiceIndicator();
  }
}

AudioEngine.prototype.setVoiceState = function(data)
{
  var channel = this.voice_channels[this.getChannelIndex(data.channel)];
  if(channel){
    channel.active = data.active;

    //update indicator
    this.updateVoiceIndicator();
  }
}

AudioEngine.prototype.isVoiceActive = function()
{
  for(var idx in this.voice_channels){
    var channel = this.voice_channels[idx];
    if(channel.active)
      return true;
  }

  return false;
}

AudioEngine.prototype.updateVoiceIndicator = function()
{
  if(this.isVoiceActive())
    this.voice_indicator_div.classList.add("active");
  else
    this.voice_indicator_div.classList.remove("active");
}
