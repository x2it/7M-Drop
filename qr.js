/*!
 * qr.js - Pure JavaScript QR Code encoder (UMD, zero runtime dependencies)
 *
 * Usage:
 *   var qr = QRCode.encode(text, 'M');   // -> { size: N, modules: Uint8Array }
 *   QRCode.toCanvas(canvasEl, text, 'M');// browser only, optional
 *
 * Implements ISO/IEC 18004: byte mode, versions 1..40, EC levels L/M/Q/H,
 * Reed-Solomon over GF(256), block interleaving, finder/separator/timing/
 * alignment patterns, dark module, BCH format & version information, and
 * all 8 data masks with standard penalty-based selection.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.QRCode = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : null), function () {
  'use strict';

  /* =====================================================================
   * Version data
   *   EC codewords per block, and number of blocks, indexed
   *   [version - 1][0..3] where 0 = L, 1 = M, 2 = Q, 3 = H.
   * ===================================================================== */
  var EC_CODEWORDS_PER_BLOCK = [
    [7, 10, 13, 17], [10, 16, 22, 28], [15, 26, 18, 22], [20, 18, 26, 16],
    [26, 24, 18, 22], [18, 16, 24, 28], [20, 18, 18, 26], [24, 22, 22, 26],
    [30, 22, 20, 24], [18, 26, 24, 28], [20, 30, 28, 24], [24, 22, 26, 28],
    [26, 22, 24, 22], [30, 24, 20, 24], [22, 24, 30, 24], [24, 28, 24, 30],
    [28, 28, 28, 28], [30, 26, 28, 28], [28, 26, 26, 26], [28, 26, 30, 28],
    [28, 26, 28, 30], [28, 28, 30, 24], [30, 28, 30, 30], [30, 28, 30, 30],
    [26, 28, 30, 30], [28, 28, 28, 30], [30, 28, 30, 30], [30, 28, 30, 30],
    [30, 28, 30, 30], [30, 28, 30, 30], [30, 28, 30, 30], [30, 28, 30, 30],
    [30, 28, 30, 30], [30, 28, 30, 30], [30, 28, 30, 30], [30, 28, 30, 30],
    [30, 28, 30, 30], [30, 28, 30, 30], [30, 28, 30, 30], [30, 28, 30, 30]
  ];

  var NUM_ERROR_CORRECTION_BLOCKS = [
    [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 2, 2], [1, 2, 2, 4],
    [1, 2, 4, 4], [2, 4, 4, 4], [2, 4, 6, 5], [2, 4, 6, 6],
    [2, 5, 8, 8], [4, 5, 8, 8], [4, 5, 8, 11], [4, 8, 10, 11],
    [4, 9, 12, 16], [4, 9, 16, 16], [6, 10, 12, 18], [6, 10, 17, 16],
    [6, 11, 16, 19], [6, 13, 18, 21], [7, 14, 21, 25], [8, 16, 20, 25],
    [8, 17, 23, 25], [9, 17, 23, 34], [9, 18, 25, 30], [10, 20, 27, 32],
    [12, 21, 29, 35], [12, 23, 34, 37], [12, 25, 34, 40], [13, 26, 35, 42],
    [14, 28, 38, 45], [15, 29, 40, 48], [16, 31, 43, 51], [17, 33, 45, 54],
    [18, 35, 48, 57], [19, 37, 51, 60], [19, 38, 53, 63], [20, 40, 56, 66],
    [21, 43, 59, 70], [22, 45, 62, 74], [24, 47, 65, 77], [25, 49, 68, 81]
  ];

  /* Alignment pattern centre coordinates per version (ISO/IEC 18004 Annex E). */
  var ALIGNMENT_PATTERN_POSITIONS = [
    [],
    [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54],
    [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
    [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86],
    [6, 34, 62, 90], [6, 28, 50, 72, 94], [6, 26, 50, 74, 98],
    [6, 30, 54, 78, 102], [6, 28, 54, 80, 106], [6, 32, 58, 84, 110],
    [6, 30, 58, 86, 114], [6, 34, 62, 90, 118], [6, 26, 50, 74, 98, 122],
    [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130],
    [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138],
    [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146],
    [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154],
    [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162],
    [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170]
  ];

  var EC_LEVEL_INDEX = { L: 0, M: 1, Q: 2, H: 3 };
  /* Format information uses a different 2-bit ordering: M, L, H, Q. */
  var EC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  /* =====================================================================
   * GF(256), primitive polynomial 0x11D
   * ===================================================================== */
  var GF_EXP = new Uint8Array(512);
  var GF_LOG = new Uint8Array(256);
  (function initGaloisField() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x = x << 1;
      if (x & 0x100) { x = x ^ 0x11D; }
    }
    for (var j = 255; j < 512; j++) { GF_EXP[j] = GF_EXP[j - 255]; }
    GF_LOG[0] = 0;
  }());

  function gfMul(a, b) {
    if (a === 0 || b === 0) { return 0; }
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  /* Reed-Solomon generator polynomial of the given degree, highest first. */
  function rsGeneratorPoly(degree) {
    var poly = [1];
    for (var d = 0; d < degree; d++) {
      var next = new Array(poly.length + 1);
      for (var k = 0; k < next.length; k++) { next[k] = 0; }
      for (var i = 0; i < poly.length; i++) {
        next[i] = next[i] ^ poly[i];
        next[i + 1] = next[i + 1] ^ gfMul(poly[i], GF_EXP[d]);
      }
      poly = next;
    }
    return poly;
  }

  /* Reed-Solomon remainder of data (returns 'degree' check codewords). */
  function rsRemainder(data, degree) {
    var gen = rsGeneratorPoly(degree);
    var res = new Array(degree);
    for (var i = 0; i < degree; i++) { res[i] = 0; }
    for (var k = 0; k < data.length; k++) {
      var factor = (data[k] ^ res[0]) & 0xFF;
      res.shift();
      res.push(0);
      if (factor !== 0) {
        for (var j = 0; j < degree; j++) {
          res[j] = res[j] ^ gfMul(gen[j + 1], factor);
        }
      }
    }
    return res;
  }

  /* =====================================================================
   * UTF-8 encoder (no TextEncoder dependency)
   * ===================================================================== */
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
        var c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
          c = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
          i++;
        }
      }
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      } else if (c < 0x10000) {
        out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      } else {
        out.push(
          0xF0 | (c >> 18),
          0x80 | ((c >> 12) & 0x3F),
          0x80 | ((c >> 6) & 0x3F),
          0x80 | (c & 0x3F)
        );
      }
    }
    return out;
  }

  /* =====================================================================
   * Bit buffer
   * ===================================================================== */
  function appendBits(buf, value, length) {
    for (var i = length - 1; i >= 0; i--) {
      buf.push((value >>> i) & 1);
    }
  }

  /* =====================================================================
   * Capacity helpers
   * ===================================================================== */
  function numRawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) { result -= 36; }
    }
    return result;
  }

  function numDataCodewords(ver, ecIndex) {
    return Math.floor(numRawDataModules(ver) / 8)
      - EC_CODEWORDS_PER_BLOCK[ver - 1][ecIndex]
      * NUM_ERROR_CORRECTION_BLOCKS[ver - 1][ecIndex];
  }

  function characterCountBits(ver) {
    return ver < 10 ? 8 : 16;
  }

  /* =====================================================================
   * Codeword construction: segment + pad + RS + interleave
   * ===================================================================== */
  function buildCodewords(data, ver, ecIndex) {
    var bits = [];
    appendBits(bits, 4, 4);                 /* byte mode indicator 0100 */
    appendBits(bits, data.length, characterCountBits(ver));
    for (var i = 0; i < data.length; i++) {
      appendBits(bits, data[i], 8);
    }

    var dataCapacityBits = numDataCodewords(ver, ecIndex) * 8;
    var terminator = Math.min(4, dataCapacityBits - bits.length);
    if (terminator > 0) { appendBits(bits, 0, terminator); }
    appendBits(bits, 0, (8 - bits.length % 8) % 8);

    var padByte = 0xEC;
    while (bits.length < dataCapacityBits) {
      appendBits(bits, padByte, 8);
      padByte = padByte === 0xEC ? 0x11 : 0xEC;
    }

    var dataCodewords = [];
    for (var b = 0; b < bits.length; b += 8) {
      var byteVal = 0;
      for (var k = 0; k < 8; k++) { byteVal = (byteVal << 1) | bits[b + k]; }
      dataCodewords.push(byteVal);
    }

    var numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ver - 1][ecIndex];
    var ecLen = EC_CODEWORDS_PER_BLOCK[ver - 1][ecIndex];
    var rawCodewords = Math.floor(numRawDataModules(ver) / 8);
    var totalBlocks = numBlocks;
    var shortBlockLen = Math.floor(rawCodewords / totalBlocks);
    var numShortBlocks = totalBlocks - (rawCodewords % totalBlocks);

    var blocks = [];
    var offset = 0;
    for (var bi = 0; bi < totalBlocks; bi++) {
      var len = shortBlockLen - ecLen + (bi < numShortBlocks ? 0 : 1);
      var dat = dataCodewords.slice(offset, offset + len);
      offset += len;
      blocks.push({ data: dat, ec: rsRemainder(dat, ecLen) });
    }

    var result = [];
    var maxDataLen = shortBlockLen - ecLen + 1;
    for (var c = 0; c < maxDataLen; c++) {
      for (var t = 0; t < totalBlocks; t++) {
        var blk = blocks[t];
        if (c < blk.data.length) { result.push(blk.data[c]); }
      }
    }
    for (var c2 = 0; c2 < ecLen; c2++) {
      for (var t2 = 0; t2 < totalBlocks; t2++) {
        result.push(blocks[t2].ec[c2]);
      }
    }
    return result;
  }

  /* =====================================================================
   * Matrix construction
   * ===================================================================== */
  function createMatrix(ver) {
    var size = ver * 4 + 17;
    var modules = [];
    var isFunction = [];
    for (var i = 0; i < size * size; i++) {
      modules.push(0);
      isFunction.push(0);
    }
    return { size: size, modules: modules, isFunction: isFunction };
  }

  function setFunc(m, x, y, dark) {
    m.modules[y * m.size + x] = dark ? 1 : 0;
    m.isFunction[y * m.size + x] = 1;
  }

  function drawFunctionPatterns(m, ver, ecIndex) {
    var size = m.size;
    var i, j;

    /* Timing patterns */
    for (i = 0; i < size; i++) {
      setFunc(m, 6, i, i % 2 === 0);
      setFunc(m, i, 6, i % 2 === 0);
    }

    /* Finder patterns + separators (drawn by clearing a 9x9 region) */
    function drawFinder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) {
        for (var dx = -4; dx <= 4; dx++) {
          var x = cx + dx;
          var y = cy + dy;
          if (x < 0 || x >= size || y < 0 || y >= size) { continue; }
          var dist = Math.max(Math.abs(dx), Math.abs(dy));
          setFunc(m, x, y, dist !== 2 && dist !== 4);
        }
      }
    }
    drawFinder(3, 3);
    drawFinder(size - 4, 3);
    drawFinder(3, size - 4);

    /* Alignment patterns */
    var pos = ALIGNMENT_PATTERN_POSITIONS[ver - 1];
    var n = pos.length;
    if (n > 0) {
      for (i = 0; i < n; i++) {
        for (j = 0; j < n; j++) {
          if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) {
            continue;
          }
          var ax = pos[j];
          var ay = pos[i];
          for (var dy2 = -2; dy2 <= 2; dy2++) {
            for (var dx2 = -2; dx2 <= 2; dx2++) {
              setFunc(m, ax + dx2, ay + dy2, Math.max(Math.abs(dx2), Math.abs(dy2)) !== 1);
            }
          }
        }
      }
    }

    /* Reserve format information areas (values written later). */
    for (i = 0; i <= 8; i++) {
      if (i !== 6) { setFunc(m, 8, i, false); }
      if (i !== 6) { setFunc(m, i, 8, false); }
    }
    for (i = 0; i < 8; i++) {
      setFunc(m, 8, size - 1 - i, false);
      setFunc(m, size - 1 - i, 8, false);
    }

    /* Dark module */
    setFunc(m, 8, size - 8, true);

    /* Version information (versions 7 and above) */
    if (ver >= 7) {
      var rem = ver;
      for (i = 0; i < 12; i++) {
        rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      }
      var bitsV = (ver << 12) | rem;
      for (i = 0; i < 18; i++) {
        var bit = (bitsV >>> i) & 1;
        var a = size - 11 + i % 3;
        var b = Math.floor(i / 3);
        setFunc(m, a, b, bit);
        setFunc(m, b, a, bit);
      }
    }

    /* Dummy format information so that all reserved modules are marked. */
    drawFormatBits(m, EC_FORMAT_BITS[['L', 'M', 'Q', 'H'][ecIndex]], 0);
  }

  function drawFormatBits(m, ecBits, mask) {
    var data = (ecBits << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) {
      rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    }
    var bits = ((data << 10) | rem) ^ 0x5412;
    var size = m.size;
    var k;

    /* Bit i is placed with i = 0 as the least significant bit of the
       15-bit sequence, matching the standard's numbering order. */

    /* Copy 1: vertical strip in the top-left, then down the bottom-left. */
    for (k = 0; k < 8; k++) {
      var vy = (k < 6) ? k : (k + 1);          /* skip the timing row 6 */
      setFunc(m, 8, vy, ((bits >>> k) & 1) !== 0);
    }
    for (k = 8; k < 15; k++) {
      setFunc(m, 8, size - 15 + k, ((bits >>> k) & 1) !== 0);
    }

    /* Copy 2: horizontal strip in the bottom-left, then the top-right. */
    for (k = 0; k < 8; k++) {
      setFunc(m, size - 1 - k, 8, ((bits >>> k) & 1) !== 0);
    }
    for (k = 8; k < 15; k++) {
      var hx = (k === 8) ? 7 : (14 - k);       /* skip the timing column 6 */
      setFunc(m, hx, 8, ((bits >>> k) & 1) !== 0);
    }

    /* Dark module, always dark. */
    setFunc(m, 8, size - 8, true);
  }

  function drawCodewords(m, codewords) {
    var size = m.size;
    var bitIndex = 0;
    var totalBits = codewords.length * 8;
    var right = size - 1;
    while (right >= 1) {
      if (right === 6) { right = 5; }
      for (var vert = 0; vert < size; vert++) {
        for (var c = 0; c < 2; c++) {
          var x = right - c;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? (size - 1 - vert) : vert;
          var idx = y * size + x;
          if (!m.isFunction[idx] && bitIndex < totalBits) {
            m.modules[idx] = (codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1;
            bitIndex++;
          }
        }
      }
      right -= 2;
    }
  }

  function maskBit(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return (x * y) % 2 + (x * y) % 3 === 0;
      case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
      case 7: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
      default: return false;
    }
  }

  function applyMask(m, mask) {
    var size = m.size;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var idx = y * size + x;
        if (m.isFunction[idx]) { continue; }
        if (maskBit(mask, x, y)) { m.modules[idx] = m.modules[idx] ^ 1; }
      }
    }
  }

  /* =====================================================================
   * Mask penalty scoring (ISO/IEC 18004 section 8.8.2)
   * ===================================================================== */
  function penaltyScore(modules, size) {
    var PENALTY_N1 = 3, PENALTY_N2 = 3, PENALTY_N3 = 40, PENALTY_N4 = 10;
    var result = 0;
    var x, y, i;

    /* N1: runs of same-colour modules in rows and columns */
    for (y = 0; y < size; y++) {
      var runColor = modules[y * size];
      var runLen = 1;
      for (x = 1; x < size; x++) {
        var c = modules[y * size + x];
        if (c === runColor) {
          runLen++;
          if (runLen === 5) { result += PENALTY_N1; }
          else if (runLen > 5) { result += 1; }
        } else {
          runColor = c;
          runLen = 1;
        }
      }
    }
    for (x = 0; x < size; x++) {
      var runColor2 = modules[x];
      var runLen2 = 1;
      for (y = 1; y < size; y++) {
        var c2 = modules[y * size + x];
        if (c2 === runColor2) {
          runLen2++;
          if (runLen2 === 5) { result += PENALTY_N1; }
          else if (runLen2 > 5) { result += 1; }
        } else {
          runColor2 = c2;
          runLen2 = 1;
        }
      }
    }

    /* N2: 2x2 blocks of same colour */
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        var a = modules[y * size + x];
        if (a === modules[y * size + x + 1] &&
            a === modules[(y + 1) * size + x] &&
            a === modules[(y + 1) * size + x + 1]) {
          result += PENALTY_N2;
        }
      }
    }

    /* N3: finder-like 1:1:3:1:1 patterns flanked by 4 light modules on at
       least one side.  Scanned as a single 11-module window so that a pattern
       with light space on BOTH sides is still penalised exactly once.
       The two legal windows are 0000 1011101 and 1011101 0000. */
    var PATTERN_A = 0x05D;   /* 00001011101 */
    var PATTERN_B = 0x5D0;   /* 10111010000 */
    for (y = 0; y < size; y++) {
      var bits = 0;
      var x2;
      for (x2 = 0; x2 < size; x2++) {
        bits = ((bits << 1) | modules[y * size + x2]) & 0x7FF;
        if (x2 >= 10 && (bits === PATTERN_A || bits === PATTERN_B)) {
          result += PENALTY_N3;
        }
      }
    }
    for (x = 0; x < size; x++) {
      var vbits = 0;
      var y2;
      for (y2 = 0; y2 < size; y2++) {
        vbits = ((vbits << 1) | modules[y2 * size + x]) & 0x7FF;
        if (y2 >= 10 && (vbits === PATTERN_A || vbits === PATTERN_B)) {
          result += PENALTY_N3;
        }
      }
    }

    /* N4: deviation of the dark-module proportion from 50%, in 5% steps.
       Integer arithmetic avoids the floating-point ambiguity of the
       "nearest 5%" wording: k = |ceil(darkPercent / 5) - 10|. */
    var dark = 0;
    for (i = 0; i < modules.length; i++) { dark += modules[i]; }
    var total = size * size;
    var k = Math.abs(Math.ceil(dark * 100 / total / 5) - 10);
    result += k * PENALTY_N4;
    return result;
  }

  /* =====================================================================
   * Core encode
   * ===================================================================== */
  function buildMatrix(text, ecLevel) {
    var key = (ecLevel === undefined || ecLevel === null) ? 'M' : String(ecLevel).toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(EC_LEVEL_INDEX, key)) {
      throw new Error('Invalid error correction level: ' + ecLevel + ' (expected L, M, Q or H)');
    }
    var ecIndex = EC_LEVEL_INDEX[key];
    var str = String(text);
    var data = utf8Bytes(str);

    var ver = 0;
    for (var v = 1; v <= 40; v++) {
      var capacityBits = numDataCodewords(v, ecIndex) * 8;
      var neededBits = 4 + characterCountBits(v) + data.length * 8;
      if (neededBits <= capacityBits) { ver = v; break; }
    }
    if (ver === 0) {
      throw new Error('Data too long: ' + data.length + ' UTF-8 bytes exceed the capacity of version 40 at level ' + key);
    }

    var codewords = buildCodewords(data, ver, ecIndex);

    var best = null;
    var bestPenalty = Infinity;
    var bestMask = -1;
    for (var mask = 0; mask < 8; mask++) {
      var m = createMatrix(ver);
      drawFunctionPatterns(m, ver, ecIndex);
      drawCodewords(m, codewords);
      drawFormatBits(m, EC_FORMAT_BITS[key], mask);
      applyMask(m, mask);
      var penalty = penaltyScore(m.modules, m.size);
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        best = m;
        bestMask = mask;
      }
    }

    return {
      size: best.size,
      modules: Uint8Array.from(best.modules),
      version: ver,
      ecLevel: key,
      mask: bestMask,
      penalty: bestPenalty
    };
  }

  /* =====================================================================
   * Public API
   * ===================================================================== */
  function encode(text, ecLevel) {
    var r = buildMatrix(text, ecLevel);
    return { size: r.size, modules: r.modules };
  }

  function encodeFull(text, ecLevel) {
    return buildMatrix(text, ecLevel);
  }

  function toCanvas(canvas, text, ecLevel, options) {
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw new Error('toCanvas requires a canvas element');
    }
    var opts = options || {};
    var quietZone = (opts.quietZone === undefined) ? 4 : opts.quietZone;
    var scale = opts.scale;
    var r = buildMatrix(text, ecLevel);
    var size = r.size;
    var totalModules = size + quietZone * 2;
    if (!scale || scale < 1) {
      scale = Math.max(1, Math.floor((opts.size || 256) / totalModules));
    }
    var pixelSize = totalModules * scale;

    canvas.width = pixelSize;
    canvas.height = pixelSize;
    if (canvas.style) {
      canvas.style.width = pixelSize + 'px';
      canvas.style.height = pixelSize + 'px';
    }

    var ctx = canvas.getContext('2d');
    if (!ctx) { throw new Error('Unable to obtain a 2D canvas context'); }
    if ('imageSmoothingEnabled' in ctx) { ctx.imageSmoothingEnabled = false; }
    if ('webkitImageSmoothingEnabled' in ctx) { ctx.webkitImageSmoothingEnabled = false; }
    if ('mozImageSmoothingEnabled' in ctx) { ctx.mozImageSmoothingEnabled = false; }
    if ('msImageSmoothingEnabled' in ctx) { ctx.msImageSmoothingEnabled = false; }

    ctx.fillStyle = opts.lightColor || '#FFFFFF';
    ctx.fillRect(0, 0, pixelSize, pixelSize);

    ctx.fillStyle = opts.darkColor || '#000000';
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        if (r.modules[y * size + x]) {
          /* Integer-aligned rects keep every module perfectly crisp. */
          ctx.fillRect((x + quietZone) * scale, (y + quietZone) * scale, scale, scale);
        }
      }
    }
    return canvas;
  }

  return {
    encode: encode,
    encodeFull: encodeFull,
    toCanvas: toCanvas,
    utf8Bytes: utf8Bytes
  };
}));
