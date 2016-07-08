'use strict';

const BinaryPack = require('js-binarypack');
const Enum       = require('enum');

const shim = require('./webrtcShim');
const RTCPeerConnection = shim.RTCPeerConnection;

const LOG_PREFIX      = 'SkyWayJS: ';

const LogLevel = new Enum({
  NONE:  0,
  ERROR: 1,
  WARN:  2,
  FULL:  3
});

const MessageTypes = new Enum([
  'OPEN',
  'ERROR',
  'OFFER',
  'ANSWER',
  'LEAVE',
  'EXPIRE',
  'CANDIDATE',
  'SFU_JOIN',
  'SFU_OFFER_REQUEST',
  'SFU_OFFER',
  'SFU_ANSWER',
  'SFU_LEAVE',
  'SFU_ANSWER',
  'SFU_USER_JOIN',
  'SFU_USER_LEAVE',
  'SFU_DATA',
  'SFU_LOG',
  'MESH_JOIN',
  'MESH_USER_JOIN',
  'MESH_USER_LIST_REQUEST',
  'MESH_USER_LIST',
  'MESH_OFFER',
  'MESH_ANSWER',
  'MESH_CANDIDATE',
  'MESH_LEAVE',
  'MESH_DATA',
  'MESH_LOG',
  'MESH_USER_LEAVE'
]);

/**
 * Class that contains utility functions.
 */
class Util {
  /**
   * Create a Util instance.
   */
  constructor() {
    this.CLOUD_HOST = 'skyway.io';
    this.CLOUD_PORT = 443;
    this.TURN_HOST = 'turn.skyway.io';
    this.TURN_PORT = 443;
    this.debug = false;
    this.pack = BinaryPack.pack;
    this.unpack = BinaryPack.unpack;
    this.setZeroTimeout = undefined;
    this.LOG_LEVELS = LogLevel;
    this.MESSAGE_TYPES = MessageTypes;

    this.chunkedBrowsers = {Chrome: 1};
    // Current recommended maximum chunksize is 16KB (DataChannel spec)
    // https://tools.ietf.org/html/draft-ietf-rtcweb-data-channel-13
    // The actual chunk size is adjusted in dataChannel to accomodate metaData
    this.maxChunkSize = 16300;

    // Number of reconnection attempts to server before giving up
    this.reconnectionAttempts = 2;

    // Send loop interval in milliseconds
    this.sendInterval = 1;

    this.defaultConfig = {
      iceServers: [{
        urls: 'stun:stun.skyway.io:3478',
        url:  'stun:stun.skyway.io:3478'
      }],
      iceTransportPolicy: 'all'
    };

    // Returns the current browser.
    this.browser = (function() {
      if (window.mozRTCPeerConnection) {
        return 'Firefox';
      }
      if (window.webkitRTCPeerConnection) {
        return 'Chrome';
      }
      if (window.RTCPeerConnection) {
        return 'Supported';
      }
      return 'Unsupported';
    })();

    this.supports = (function() {
      if (typeof RTCPeerConnection === 'undefined') {
        return {};
      }

      let data = true;
      let binaryBlob = false;

      let pc;
      let dc;
      try {
        pc = new RTCPeerConnection(this.defaultConfig, {});
      } catch (e) {
        data = false;
      }

      if (data) {
        try {
          dc = pc.createDataChannel('_SKYWAYTEST');
        } catch (e) {
          data = false;
        }
      }

      if (data) {
        // Binary test
        try {
          dc.binaryType = 'blob';
          binaryBlob = true;
        } catch (e) {
          // binaryBlob is already false
        }
      }

      if (pc) {
        pc.close();
      }

      return {
        binaryBlob: binaryBlob
      };
    })();

    this._logLevel = LogLevel.NONE.value;
  }

  /**
   * Set the level of log.
   * @param {Integer} [level=0] The log level. 0: NONE, 1: ERROR, 2: WARN, 3:FULL.
   */
  setLogLevel(level) {
    if (level.value) {
      level = level.value;
    }

    const decimalRadix = 10;
    let debugLevel = parseInt(level, decimalRadix);

    switch (debugLevel) {
      case 0:
        this._logLevel = LogLevel.NONE.value;
        break;
      case 1:
        this._logLevel = LogLevel.ERROR.value;
        break;
      case 2:
        this._logLevel = LogLevel.WARN.value;
        break;
      case 3:
        this._logLevel = LogLevel.FULL.value;
        break;
      default:
        this._logLevel = LogLevel.NONE.value;
        break;
    }
  }

  /**
   * Output a warning message to the Web Console.
   */
  warn() {
    if (this._logLevel >= LogLevel.WARN.value) {
      let copy = Array.prototype.slice.call(arguments);
      copy.unshift(LOG_PREFIX);
      console.warn.apply(console, copy);
    }
  }

  /**
   * Output an error message to the Web Console.
   */
  error() {
    if (this._logLevel >= LogLevel.ERROR.value) {
      let copy = Array.prototype.slice.call(arguments);
      copy.unshift(LOG_PREFIX);
      console.error.apply(console, copy);
    }
  }

  /**
   * Output a log message to the Web Console.
   */
  log() {
    if (this._logLevel >= LogLevel.FULL.value) {
      let copy = Array.prototype.slice.call(arguments);
      copy.unshift(LOG_PREFIX);
      console.log.apply(console, copy);
    }
  }

  /**
   * Validate the Peer ID.
   * @param {string} [id] - A Peer ID.
   * @return {boolean} Whether the is is proper or not.
   */
  validateId(id) {
    // Allow empty ids
    return !id || /^[A-Za-z0-9_-]+(?:[ _-][A-Za-z0-9]+)*$/.exec(id);
  }

  /**
   * Validate the API key.
   * @param {string} [key] A SkyWay API key.
   * @return {boolean} Whether the key is proper or not.
   */
  validateKey(key) {
    // Allow empty keys
    return !key || /^[a-z0-9]{8}(-[a-z0-9]{4}){3}-[a-z0-9]{12}$/.exec(key);
  }

  /**
   * Generate random token.
   * @return {string} A token consisting of random alphabet and integer.
   */
  randomToken() {
    return Math.random().toString(36).substr(2);
  }

  /**
   * Slice the Blob.
   * @param {Blob} blob - The Blob that is sliced some Blobs.
   * @return {Array} A Array of Blobs.
   */
  chunk(blob) {
    let chunks = [];
    let size = blob.size;
    let start = 0;
    let index = 0;
    let total = Math.ceil(size / this.chunkedMTU);
    while (start < size) {
      let end = Math.min(size, start + this.chunkedMTU);
      let blobSlice = blob.slice(start, end);

      let chunk = {
        parentMsgId: this.chunkedCount,
        chunkIndex:  index,
        chunkData:   blobSlice,
        totalChunks: total
      };

      chunks.push(chunk);

      start = end;
      index++;
    }
    this.chunkedCount++;
    return chunks;
  }

  /**
   * Combine the sliced ArrayBuffers.
   * @param {Array} buffers - An Array of ArrayBuffer.
   * @return {ArrayBuffer} A ArrayBuffer consisting of given ArrayBuffers.
   */
  joinArrayBuffers(buffers) {
    let size = buffers.reduce((sum, buffer) => {
      return sum + buffer.byteLength;
    }, 0);
    let tmpArray = new Uint8Array(size);
    let currPos = 0;
    for (let buffer of buffers) {
      tmpArray.set(new Uint8Array(buffer), currPos);
      currPos += buffer.byteLength;
    }
    return tmpArray.buffer;
  }

  /**
   * Convert Blob to ArrayBuffer.
   * @param {Blob} blob - The Blob to be read as ArrayBuffer.
   * @param {Function} cb - Callback function that called after load event fired.
   */
  blobToArrayBuffer(blob, cb) {
    let fr = new FileReader();
    fr.onload = event => {
      cb(event.target.result);
    };
    fr.readAsArrayBuffer(blob);
  }

  /**
   * Convert Blob to BinaryString.
   * @param {Blob} blob - The Blob to be read as BinaryString.
   * @param {Function} cb - Callback function that called after load event fired.
   */
  blobToBinaryString(blob, cb) {
    let fr = new FileReader();
    fr.onload = event => {
      cb(event.target.result);
    };
    fr.readAsBinaryString(blob);
  }

  /**
   * Convert Blob to text.
   * @param {Blob} blob - The Blob to be read as text.
   * @param {Function} cb - Callback function that called after load event fired.
   */
  blobToString(blob, cb) {
    let fr = new FileReader();
    fr.onload = event => {
      cb(event.target.result);
    };
    fr.readAsText(blob);
  }

  /**
   * Convert BinaryString to ArrayBuffer.
   * @param {BinaryString} binary - The BinaryString that is converted to ArrayBuffer.
   * @return {string} An ArrayBuffer.
   */
  binaryStringToArrayBuffer(binary) {
    let byteArray = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      byteArray[i] = binary.charCodeAt(i) & 0xff;
    }
    return byteArray.buffer;
  }

  /**
   * Return random ID.
   * @return {string} A text consisting of 16 chars.
   */
  randomId() {
    const keyLength = 16;
    // '36' means that we want to convert the number to a string using chars in
    // the range of '0-9a-z'. The concatenated 0's are for padding the key,
    // as Math.random() may produce a key shorter than 16 chars in length
    const randString = Math.random().toString(36) + '0000000000000000000';
    return randString.substr(2, keyLength);
  }

  /**
   * Whether the protocol is https or not.
   * @return {boolean} Whether the protocol is https of not.
   */
  isSecure() {
    return location.protocol === 'https:';
  }
}

module.exports = new Util();
