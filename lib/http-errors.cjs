'use strict';

// Fehler mit HTTP-Status. Routen geben error.message nur bei gesetztem status
// an den Client weiter; Fehler ohne status gelten als unerwartet (500).
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

module.exports = { httpError };
