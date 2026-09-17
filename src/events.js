'use strict';
/* Single event bus: services publish, the SSE route fan-outs to browsers. */

const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(0); // many SSE clients are expected

module.exports = bus;
