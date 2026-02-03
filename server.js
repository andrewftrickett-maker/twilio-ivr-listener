const express = require('express');
const WebSocket = require('ws');
const twilio = require('twilio');

const app = express();
const PORT = process.env.PORT || 3000;

// Twilio credentials from environment variables
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// IVR Flow Configuration - Employee 1, Regular Service, Check-In
const IVR_FLOW = {
  step1: {
    listenFor: ['enter employee', 'employee id', 'vesta'],
    sendDTMF: '1w2w3w4',  // Employee ID: 1234
    nextStep: 'step2'
  },
  step2: {
    listenFor: ['member id', 'enter a member'],
    sendDTMF: '1w2w3w4w5w6',  // Member ID: 123456
    nextStep: 'step3'
  },
  step3: {
    listenFor: ['clock in', 'clock out', 'enter 1 to clock', 'enter 2 to clock'],
    sendDTMF: '1',  // 1 = check-in
    nextStep: 'step4'
  },
  step4: {
    listenFor: ['overnight', 'overnight visit'],
    sendDTMF: '',  // Don't send anything, just wait
    nextStep: 'step5',
    waitOnly: true  // Flag to indicate we're just waiting for next prompt
  },
  step5: {
    listenFor: ['token number', 'enter token'],
    sendDTMF: '',  // Don't send anything, just wait
    nextStep: 'step6',
    waitOnly: true
  },
  step6: {
    listenFor: ['time'],
    sendDTMF: '',  // Success! Call complete
    nextStep: 'complete',
    successIndicator: true  // This confirms the call worked
  }
};

// Track active calls and their state
const activeCalls = new Map();

// Deepgram WebSocket connection for transcription
function connectToDeepgram(callSid) {
  const deepgramWs = new WebSocket('wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&model=phonecall', {
    headers: {
      'Authorization': `Token ${DEEPGRAM_API_KEY}`
    }
  });

  deepgramWs.on('open', () => {
    console.log(`[${callSid}] Deepgram connection opened`);
  });

  deepgramWs.on('message', async (data) => {
    const response = JSON.parse(data);
    
    if (response.channel && response.channel.alternatives && response.channel.alternatives[0]) {
      const transcript = response.channel.alternatives[0].transcript.toLowerCase();
      
      if (transcript) {
        console.log(`[${callSid}] Transcript: "${transcript}"`);
        await handleTranscript(callSid, transcript);
      }
    }
  });

  deepgramWs.on('error', (error) => {
    console.error(`[${callSid}] Deepgram error:`, error);
  });

  deepgramWs.on('close', () => {
    console.log(`[${callSid}] Deepgram connection closed`);
  });

  return deepgramWs;
}

// Handle transcript and check for phrase matches
async function handleTranscript(callSid, transcript) {
  const callState = activeCalls.get(callSid);
  if (!callState) return;

  const currentStep = IVR_FLOW[callState.currentStep];
  if (!currentStep) return;

  // Check if any trigger phrase is detected
  const matched = currentStep.listenFor.some(phrase => transcript.includes(phrase));

  if (matched) {
    console.log(`[${callSid}] MATCH FOUND for step ${callState.currentStep}!`);
    
    // If this is a wait-only step, just move to next step without sending DTMF
    if (currentStep.waitOnly) {
      console.log(`[${callSid}] Wait-only step - moving to ${currentStep.nextStep}`);
      callState.currentStep = currentStep.nextStep;
      callState.lastMatch = new Date();
      return;
    }

    // If this is the success indicator, log it
    if (currentStep.successIndicator) {
      console.log(`[${callSid}] SUCCESS! Call completed successfully - heard time confirmation`);
      callState.currentStep = 'complete';
      callState.success = true;
      callState.completedAt = new Date();
      return;
    }

    // Send DTMF if specified
    if (currentStep.sendDTMF) {
      console.log(`[${callSid}] Sending DTMF: ${currentStep.sendDTMF}`);
      
      try {
        await twilioClient.calls(callSid).update({
          twiml: `<Response><Play digits="${currentStep.sendDTMF}"/></Response>`
        });

        // Move to next step
        callState.currentStep = currentStep.nextStep;
        callState.lastMatch = new Date();

        if (currentStep.nextStep === 'complete') {
          console.log(`[${callSid}] Flow complete - all steps executed`);
        }
      } catch (error) {
        console.error(`[${callSid}] Error sending DTMF:`, error);
      }
    }
  }
}

// Twilio Media Streams WebSocket endpoint
const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws) => {
  console.log('New WebSocket connection from Twilio');
  let callSid = null;
  let deepgramWs = null;
  let streamSid = null;

  ws.on('message', (message) => {
    const msg = JSON.parse(message);

    switch (msg.event) {
      case 'start':
        callSid = msg.start.callSid;
        streamSid = msg.start.streamSid;
        console.log(`[${callSid}] Media stream started`);

        // Initialize call state
        activeCalls.set(callSid, {
          currentStep: 'step1',
          streamSid: streamSid,
          startTime: new Date()
        });

        // Connect to Deepgram for transcription
        deepgramWs = connectToDeepgram(callSid);
        activeCalls.get(callSid).deepgramWs = deepgramWs;
        break;

      case 'media':
        // Forward audio to Deepgram
        if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
          const audioPayload = Buffer.from(msg.media.payload, 'base64');
          deepgramWs.send(audioPayload);
        }
        break;

      case 'stop':
        console.log(`[${callSid}] Media stream stopped`);
        
        // Clean up
        if (deepgramWs) {
          deepgramWs.close();
        }
        activeCalls.delete(callSid);
        break;
    }
  });

  ws.on('close', () => {
    console.log(`[${callSid}] WebSocket closed`);
    if (deepgramWs) {
      deepgramWs.close();
    }
    if (callSid) {
      activeCalls.delete(callSid);
    }
  });
});

// HTTP endpoints
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  res.send('Twilio IVR Listener is running');
});

// TwiML endpoint for initiating calls
app.post('/start-call', (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.get('host')}/media-stream" />
  </Connect>
  <Dial>${process.env.IVR_PHONE_NUMBER}</Dial>
</Response>`;
  
  res.type('text/xml');
  res.send(twiml);
});

// Call status callback endpoint
app.post('/call-status', (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  console.log(`[${callSid}] Call status: ${callStatus}`);
  res.sendStatus(200);
});

// Status endpoint to check active calls
app.get('/status', (req, res) => {
  const calls = Array.from(activeCalls.entries()).map(([sid, state]) => ({
    callSid: sid,
    currentStep: state.currentStep,
    startTime: state.startTime,
    success: state.success || false
  }));
  
  res.json({
    activeCalls: calls.length,
    calls: calls
  });
});

// Start HTTP server
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Upgrade HTTP connections to WebSocket for /media-stream
server.on('upgrade', (request, socket, head) => {
  if (request.url === '/media-stream') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  }
});
