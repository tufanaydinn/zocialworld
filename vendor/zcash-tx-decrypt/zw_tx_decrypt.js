
let imports = {};
imports['__wbindgen_placeholder__'] = module.exports;
let wasm;
const { TextEncoder, TextDecoder } = require(`util`);

let WASM_VECTOR_LEN = 0;

let cachedUint8ArrayMemory0 = null;

function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

let cachedTextEncoder = new TextEncoder('utf-8');

const encodeString = (typeof cachedTextEncoder.encodeInto === 'function'
    ? function (arg, view) {
    return cachedTextEncoder.encodeInto(arg, view);
}
    : function (arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
        read: arg.length,
        written: buf.length
    };
});

function passStringToWasm0(arg, malloc, realloc) {

    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }

    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = encodeString(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedDataViewMemory0 = null;

function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });

cachedTextDecoder.decode();

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_export_4.set(idx, obj);
    return idx;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_export_4.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}
/**
 * Trial-decrypts every Sapling, Orchard and Ironwood output of a raw transaction with a unified
 * full viewing key. `height` is the block height the transaction was mined at (or the chain tip
 * + 1 for an unmined one). Returns the outputs the key can see (empty when none).
 * Throws an Error whose `code` is `invalid_hex`, `invalid_height`, `invalid_transaction`,
 * `invalid_network` or `invalid_ufvk`.
 * @param {string} raw_tx_hex
 * @param {number} height
 * @param {ZwNetwork} network
 * @param {string} ufvk
 * @returns {ZwDecryptedOutput[]}
 */
module.exports.decryptTransaction = function(raw_tx_hex, height, network, ufvk) {
    const ptr0 = passStringToWasm0(raw_tx_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(network, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(ufvk, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.decryptTransaction(ptr0, len0, height, ptr1, len1, ptr2, len2);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
};

/**
 * One-time operator setup: derives the project's registry keys from its seed phrase.
 * Returns `{ ufvk, unifiedAddress (Orchard-family + Sapling + transparent), unifiedShieldedAddress
 * (Orchard-family + Sapling), unifiedSaplingTransparentAddress (Sapling + transparent: the Stage-1
 * address), saplingAddress, transparentAddress, diversifierIndex }`. The seed is never logged or
 * returned.
 * Throws with `code` `invalid_seed_phrase`, `invalid_network` or `invalid_account`.
 * @param {string} seed_phrase
 * @param {ZwNetwork} network
 * @param {number} account
 * @returns {ZwRegistryKeys}
 */
module.exports.registryKeysFromSeed = function(seed_phrase, network, account) {
    const ptr0 = passStringToWasm0(seed_phrase, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(network, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.registryKeysFromSeed(ptr0, len0, ptr1, len1, account);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
};

/**
 * The fee/registry addresses that belong to a viewing key (what `registryKeysFromSeed` returns,
 * without the seed and the key): `{ unifiedAddress, unifiedShieldedAddress,
 * unifiedSaplingTransparentAddress, saplingAddress, transparentAddress, diversifierIndex }`.
 * @param {string} ufvk
 * @param {ZwNetwork} network
 * @returns {ZwKeyAddresses}
 */
module.exports.addressesFromUfvk = function(ufvk, network) {
    const ptr0 = passStringToWasm0(ufvk, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(network, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.addressesFromUfvk(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
};

/**
 * The shape of a raw transaction: version, consensus branch, bundle sizes.
 * @param {string} raw_tx_hex
 * @param {number} height
 * @param {ZwNetwork} network
 * @returns {ZwTxShape}
 */
module.exports.inspectTransaction = function(raw_tx_hex, height, network) {
    const ptr0 = passStringToWasm0(raw_tx_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(network, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.inspectTransaction(ptr0, len0, height, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
};

/**
 * Describes an encoded Zcash address: `{ network, kind, receivers, hasSapling, hasOrchard,
 * hasTransparent }`. Throws with `code` `invalid_address`.
 * @param {string} address
 * @returns {ZwAddressInfo}
 */
module.exports.describeAddress = function(address) {
    const ptr0 = passStringToWasm0(address, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.describeAddress(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
};

/**
 * The librustzcash / orchard revisions this helper was built from (must match the wallet's).
 * @returns {string}
 */
module.exports.buildInfo = function() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.buildInfo();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
};

module.exports.__wbg_String_8f0eb39a4a4c2f66 = function(arg0, arg1) {
    const ret = String(arg1);
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
};

module.exports.__wbg_new_405e22f390576ce2 = function() {
    const ret = new Object();
    return ret;
};

module.exports.__wbg_new_5e0be73521bc8c17 = function() {
    const ret = new Map();
    return ret;
};

module.exports.__wbg_new_78feb108b6472713 = function() {
    const ret = new Array();
    return ret;
};

module.exports.__wbg_new_c68d7209be747379 = function(arg0, arg1) {
    const ret = new Error(getStringFromWasm0(arg0, arg1));
    return ret;
};

module.exports.__wbg_set_37837023f3d740e8 = function(arg0, arg1, arg2) {
    arg0[arg1 >>> 0] = arg2;
};

module.exports.__wbg_set_3f1d0b984ed272ed = function(arg0, arg1, arg2) {
    arg0[arg1] = arg2;
};

module.exports.__wbg_set_8fc6bf8a5b1071d1 = function(arg0, arg1, arg2) {
    const ret = arg0.set(arg1, arg2);
    return ret;
};

module.exports.__wbg_set_bb8cecf6a62b9f46 = function() { return handleError(function (arg0, arg1, arg2) {
    const ret = Reflect.set(arg0, arg1, arg2);
    return ret;
}, arguments) };

module.exports.__wbindgen_bigint_from_u64 = function(arg0) {
    const ret = BigInt.asUintN(64, arg0);
    return ret;
};

module.exports.__wbindgen_error_new = function(arg0, arg1) {
    const ret = new Error(getStringFromWasm0(arg0, arg1));
    return ret;
};

module.exports.__wbindgen_init_externref_table = function() {
    const table = wasm.__wbindgen_export_4;
    const offset = table.grow(4);
    table.set(0, undefined);
    table.set(offset + 0, undefined);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
    ;
};

module.exports.__wbindgen_is_string = function(arg0) {
    const ret = typeof(arg0) === 'string';
    return ret;
};

module.exports.__wbindgen_number_new = function(arg0) {
    const ret = arg0;
    return ret;
};

module.exports.__wbindgen_string_new = function(arg0, arg1) {
    const ret = getStringFromWasm0(arg0, arg1);
    return ret;
};

module.exports.__wbindgen_throw = function(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
};

const path = require('path').join(__dirname, 'zw_tx_decrypt_bg.wasm');
const bytes = require('fs').readFileSync(path);

const wasmModule = new WebAssembly.Module(bytes);
const wasmInstance = new WebAssembly.Instance(wasmModule, imports);
wasm = wasmInstance.exports;
module.exports.__wasm = wasm;

wasm.__wbindgen_start();

