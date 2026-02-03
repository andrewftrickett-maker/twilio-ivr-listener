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
const activeCalls = new M
