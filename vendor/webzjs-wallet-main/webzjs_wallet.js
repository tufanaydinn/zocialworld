import { JSArrayBufferCopy } from './snippets/wasm-array-cp-201e2a98f0e691f7/copy.min.js';
import { startWorkers } from './snippets/wasm-bindgen-rayon-38edf6e439f6d70d/src/workerHelpers.js';
import * as __wbg_star0 from './snippets/wasm_thread-8ee53d0673203880/src/wasm32/js/module_worker_start.js';
import * as __wbg_star1 from './snippets/wasm_thread-8ee53d0673203880/src/wasm32/js/module_workers_polyfill.min.js';

let wasm;

let WASM_VECTOR_LEN = 0;

let cachedUint8ArrayMemory0 = null;

function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.buffer !== wasm.memory.buffer) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

const cachedTextEncoder = (typeof TextEncoder !== 'undefined' ? new TextEncoder('utf-8') : { encode: () => { throw Error('TextEncoder not available') } } );

const encodeString = function (arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
        read: arg.length,
        written: buf.length
    };
};

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
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer !== wasm.memory.buffer) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

const cachedTextDecoder = (typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }) : { decode: () => { throw Error('TextDecoder not available') } } );

if (typeof TextDecoder !== 'undefined') { cachedTextDecoder.decode(); };

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return cachedTextDecoder.decode(getUint8ArrayMemory0().slice(ptr, ptr + len));
}

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_export_5.set(idx, obj);
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

function isLikeNone(x) {
    return x === undefined || x === null;
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => {
    wasm.__wbindgen_export_7.get(state.dtor)(state.a, state.b)
});

function makeMutClosure(arg0, arg1, dtor, f) {
    const state = { a: arg0, b: arg1, cnt: 1, dtor };
    const real = (...args) => {
        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            if (--state.cnt === 0) {
                wasm.__wbindgen_export_7.get(state.dtor)(a, state.b);
                CLOSURE_DTORS.unregister(state);
            } else {
                state.a = a;
            }
        }
    };
    real.original = state;
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_export_5.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    for (let i = 0; i < array.length; i++) {
        const add = addToExternrefTable0(array[i]);
        getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
}
/**
 * The consensus branch this wallet build targets, as lightwalletd prints it ("37a5165b" =
 * NU6.3). Sending is refused when the chain reports another branch.
 * @returns {string}
 */
export function expected_consensus_branch() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.expected_consensus_branch();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(wasm.__wbindgen_export_5.get(mem.getUint32(i, true)));
    }
    wasm.__externref_drop_slice(ptr, len);
    return result;
}
/**
 * The stable error codes the engine's errors may carry (as `error.code` and as the message
 * prefix "<code>: "). Name kept from Stage 1.
 * @returns {string[]}
 */
export function sapling_beta_error_codes() {
    const ret = wasm.sapling_beta_error_codes();
    var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

/**
 * Build facts for diagnostics and the game's update check: `{ backend, txVersion,
 * expectedBranch, supportedBranches, pools, regtest, errorCodes, retiredErrorCodes }`.
 * @returns {WalletEngineInfo}
 */
export function engine_info() {
    const ret = wasm.engine_info();
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Diagnostics: the wallet database files this engine instance holds in its memory VFS. A wallet
 * that was dropped (`free()`, or garbage-collected) leaves none behind.
 * @returns {string[]}
 */
export function open_wallet_databases() {
    const ret = wasm.open_wallet_databases();
    var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

export function start() {
    wasm.start();
}

/**
 * @param {number} num_threads
 * @returns {Promise<any>}
 */
export function initThreadPool(num_threads) {
    const ret = wasm.initThreadPool(num_threads);
    return ret;
}

/**
 * @param {number} receiver
 */
export function wbg_rayon_start_worker(receiver) {
    wasm.wbg_rayon_start_worker(receiver);
}

/**
 * Generate a new BIP39 24-word seed phrase
 *
 * IMPORTANT: This probably does not use secure randomness when used in the browser
 * and should not be used for anything other than testing
 *
 * # Returns
 *
 * A string containing a 24-word seed phrase
 * @returns {string}
 */
export function generate_seed_phrase() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.generate_seed_phrase();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Recover a human-verifiable summary of what a PCZT does.
 *
 * The Snap renders THIS, never the caller-supplied `signDetails`.
 *
 * # Arguments
 * * `network` - "main" or "test"
 * * `pczt` - the PCZT the dApp wants signed
 * * `ufvk` - the signer's Unified Full Viewing Key (for OVK/IVK recovery)
 *
 * # Returns
 * A JSON [`PcztSummary`] (`{ network, outputs, total_in, total_out, fee }`).
 * @param {string} network
 * @param {Pczt} pczt
 * @param {UnifiedFullViewingKey} ufvk
 * @returns {any}
 */
export function pczt_describe(network, pczt, ufvk) {
    const ptr0 = passStringToWasm0(network, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    _assertClass(pczt, Pczt);
    _assertClass(ufvk, UnifiedFullViewingKey);
    const ret = wasm.pczt_describe(ptr0, len0, pczt.__wbg_ptr, ufvk.__wbg_ptr);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Validate that a PCZT is safe to sign with this user's key.
 *
 * Returns `Ok(())` only if every spend is the user's, value balances, and the
 * fee is sane. Any failure is a hard reject — this is what kills blind signing.
 * @param {string} network
 * @param {Pczt} pczt
 * @param {UnifiedFullViewingKey} ufvk
 */
export function pczt_validate(network, pczt, ufvk) {
    const ptr0 = passStringToWasm0(network, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    _assertClass(pczt, Pczt);
    _assertClass(ufvk, UnifiedFullViewingKey);
    const ret = wasm.pczt_validate(ptr0, len0, pczt.__wbg_ptr, ufvk.__wbg_ptr);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * Signs and applies signatures to a PCZT.
 * Should in a secure environment (e.g. Metamask snap).
 *
 * # Arguments
 *
 * * `pczt` - The PCZT that needs to signed
 * * `usk` - UnifiedSpendingKey used to sign the PCZT
 * * `seed_fp` - The fingerprint of the seed used to create `usk`
 * @param {string} network
 * @param {Pczt} pczt
 * @param {UnifiedSpendingKey} usk
 * @param {SeedFingerprint} seed_fp
 * @returns {Promise<Pczt>}
 */
export function pczt_sign(network, pczt, usk, seed_fp) {
    const ptr0 = passStringToWasm0(network, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    _assertClass(pczt, Pczt);
    var ptr1 = pczt.__destroy_into_raw();
    _assertClass(usk, UnifiedSpendingKey);
    var ptr2 = usk.__destroy_into_raw();
    _assertClass(seed_fp, SeedFingerprint);
    var ptr3 = seed_fp.__destroy_into_raw();
    const ret = wasm.pczt_sign(ptr0, len0, ptr1, ptr2, ptr3);
    return ret;
}

/**
 * Entry point for web workers
 * @param {number} ptr
 */
export function wasm_thread_entry_point(ptr) {
    wasm.wasm_thread_entry_point(ptr);
}

function __wbg_adapter_54(arg0, arg1, arg2) {
    wasm.closure2911_externref_shim(arg0, arg1, arg2);
}

function __wbg_adapter_59(arg0, arg1) {
    wasm._dyn_core__ops__function__FnMut_____Output___R_as_wasm_bindgen__closure__WasmClosure___describe__invoke__h1ec9f2f4bb78ee38(arg0, arg1);
}

function __wbg_adapter_62(arg0, arg1, arg2) {
    wasm.closure2982_externref_shim(arg0, arg1, arg2);
}

function __wbg_adapter_444(arg0, arg1, arg2, arg3) {
    wasm.closure4389_externref_shim(arg0, arg1, arg2, arg3);
}

/**
 * The status of a transaction
 * @enum {0 | 1 | 2}
 */
export const TransactionStatusType = Object.freeze({
    /**
     * Transaction has been mined
     */
    Confirmed: 0, "0": "Confirmed",
    /**
     * Transaction is waiting to be mined
     */
    Pending: 1, "1": "Pending",
    /**
     * Transaction has expired without being mined
     */
    Expired: 2, "2": "Expired",
});
/**
 * The type of transaction
 * @enum {0 | 1 | 2}
 */
export const TransactionType = Object.freeze({
    /**
     * Funds received from external source
     */
    Received: 0, "0": "Received",
    /**
     * Funds sent to external recipient
     */
    Sent: 1, "1": "Sent",
    /**
     * Internal transfer (shielding, de-shielding, or pool migration)
     */
    Shielded: 2, "2": "Shielded",
});

const __wbindgen_enum_ReadableStreamType = ["bytes"];

const __wbindgen_enum_ReferrerPolicy = ["", "no-referrer", "no-referrer-when-downgrade", "origin", "origin-when-cross-origin", "unsafe-url", "same-origin", "strict-origin", "strict-origin-when-cross-origin"];

const __wbindgen_enum_RequestCache = ["default", "no-store", "reload", "no-cache", "force-cache", "only-if-cached"];

const __wbindgen_enum_RequestCredentials = ["omit", "same-origin", "include"];

const __wbindgen_enum_RequestMode = ["same-origin", "no-cors", "cors", "navigate"];

const __wbindgen_enum_RequestRedirect = ["follow", "error", "manual"];

const __wbindgen_enum_WorkerType = ["classic", "module"];

const BlockRangeFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_blockrange_free(ptr >>> 0, 1));

export class BlockRange {

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BlockRangeFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_blockrange_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get 0() {
        const ret = wasm.__wbg_get_blockrange_0(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set 0(arg0) {
        wasm.__wbg_set_blockrange_0(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get 1() {
        const ret = wasm.__wbg_get_blockrange_1(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set 1(arg0) {
        wasm.__wbg_set_blockrange_1(this.__wbg_ptr, arg0);
    }
}

const IntoUnderlyingByteSourceFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_intounderlyingbytesource_free(ptr >>> 0, 1));

export class IntoUnderlyingByteSource {

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IntoUnderlyingByteSourceFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_intounderlyingbytesource_free(ptr, 0);
    }
    /**
     * @returns {ReadableStreamType}
     */
    get type() {
        const ret = wasm.intounderlyingbytesource_type(this.__wbg_ptr);
        return __wbindgen_enum_ReadableStreamType[ret];
    }
    /**
     * @returns {number}
     */
    get autoAllocateChunkSize() {
        const ret = wasm.intounderlyingbytesource_autoAllocateChunkSize(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {ReadableByteStreamController} controller
     */
    start(controller) {
        wasm.intounderlyingbytesource_start(this.__wbg_ptr, controller);
    }
    /**
     * @param {ReadableByteStreamController} controller
     * @returns {Promise<any>}
     */
    pull(controller) {
        const ret = wasm.intounderlyingbytesource_pull(this.__wbg_ptr, controller);
        return ret;
    }
    cancel() {
        const ptr = this.__destroy_into_raw();
        wasm.intounderlyingbytesource_cancel(ptr);
    }
}

const IntoUnderlyingSinkFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_intounderlyingsink_free(ptr >>> 0, 1));

export class IntoUnderlyingSink {

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IntoUnderlyingSinkFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_intounderlyingsink_free(ptr, 0);
    }
    /**
     * @param {any} chunk
     * @returns {Promise<any>}
     */
    write(chunk) {
        const ret = wasm.intounderlyingsink_write(this.__wbg_ptr, chunk);
        return ret;
    }
    /**
     * @returns {Promise<any>}
     */
    close() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.intounderlyingsink_close(ptr);
        return ret;
    }
    /**
     * @param {any} reason
     * @returns {Promise<any>}
     */
    abort(reason) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.intounderlyingsink_abort(ptr, reason);
        return ret;
    }
}

const IntoUnderlyingSourceFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_intounderlyingsource_free(ptr >>> 0, 1));

export class IntoUnderlyingSource {

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IntoUnderlyingSourceFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_intounderlyingsource_free(ptr, 0);
    }
    /**
     * @param {ReadableStreamDefaultController} controller
     * @returns {Promise<any>}
     */
    pull(controller) {
        const ret = wasm.intounderlyingsource_pull(this.__wbg_ptr, controller);
        return ret;
    }
    cancel() {
        const ptr = this.__destroy_into_raw();
        wasm.intounderlyingsource_cancel(ptr);
    }
}

const PcztFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_pczt_free(ptr >>> 0, 1));

export class Pczt {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Pczt.prototype);
        obj.__wbg_ptr = ptr;
        PcztFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    static __unwrap(jsValue) {
        if (!(jsValue instanceof Pczt)) {
            return 0;
        }
        return jsValue.__destroy_into_raw();
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PcztFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_pczt_free(ptr, 0);
    }
    /**
     * Returns the postcard serialization of the Pczt (latest PCZT version).
     * @returns {Uint8Array}
     */
    serialize() {
        const ret = wasm.pczt_serialize(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Deserialize to a Pczt from postcard bytes.
     * @param {Uint8Array} bytes
     * @returns {Pczt}
     */
    static from_bytes(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.pczt_from_bytes(ptr0, len0);
        return Pczt.__wrap(ret);
    }
}

const ProofGenerationKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_proofgenerationkey_free(ptr >>> 0, 1));
/**
 * A Zcash Sapling proof generation key
 *
 * This is a wrapper around the `sapling::ProofGenerationKey` type. It is used for generating proofs for Sapling PCZTs.
 */
export class ProofGenerationKey {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(ProofGenerationKey.prototype);
        obj.__wbg_ptr = ptr;
        ProofGenerationKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProofGenerationKeyFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_proofgenerationkey_free(ptr, 0);
    }
}

const ProposalFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_proposal_free(ptr >>> 0, 1));
/**
 * A handler to an immutable proposal. This can be passed to `create_proposed_transactions` to prove/authorize the transactions
 * before they are sent to the network.
 *
 * Stage 2: the note references are the SQLite wallet database's (`zcash_client_sqlite::ReceivedNoteId`).
 */
export class Proposal {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Proposal.prototype);
        obj.__wbg_ptr = ptr;
        ProposalFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProposalFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_proposal_free(ptr, 0);
    }
}

const SeedFingerprintFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_seedfingerprint_free(ptr >>> 0, 1));
/**
 * A ZIP32 seed fingerprint. Essentially a Blake2b hash of the seed.
 *
 * This is a wrapper around the `zip32::fingerprint::SeedFingerprint` type.
 */
export class SeedFingerprint {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(SeedFingerprint.prototype);
        obj.__wbg_ptr = ptr;
        SeedFingerprintFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SeedFingerprintFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_seedfingerprint_free(ptr, 0);
    }
    /**
     * Construct a new SeedFingerprint
     *
     * # Arguments
     *
     * * `seed` - At least 32 bytes of entry. Care should be taken as to how this is derived
     * @param {Uint8Array} seed
     */
    constructor(seed) {
        const ptr0 = passArray8ToWasm0(seed, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.seedfingerprint_new(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        SeedFingerprintFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {Uint8Array}
     */
    to_bytes() {
        const ret = wasm.seedfingerprint_to_bytes(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @param {Uint8Array} bytes
     * @returns {SeedFingerprint}
     */
    static from_bytes(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.seedfingerprint_from_bytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return SeedFingerprint.__wrap(ret[0]);
    }
}

const TransactionHistoryEntryFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_transactionhistoryentry_free(ptr >>> 0, 1));
/**
 * A single transaction history entry
 */
export class TransactionHistoryEntry {

    toJSON() {
        return {
            txid: this.txid,
            tx_type: this.tx_type,
            value: this.value,
            fee: this.fee,
            block_height: this.block_height,
            confirmations: this.confirmations,
            status: this.status,
            memo: this.memo,
            timestamp: this.timestamp,
            pool: this.pool,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TransactionHistoryEntryFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_transactionhistoryentry_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    get txid() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.transactionhistoryentry_txid(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {TransactionType}
     */
    get tx_type() {
        const ret = wasm.transactionhistoryentry_tx_type(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {bigint}
     */
    get value() {
        const ret = wasm.transactionhistoryentry_value(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {bigint | undefined}
     */
    get fee() {
        const ret = wasm.transactionhistoryentry_fee(this.__wbg_ptr);
        return ret[0] === 0 ? undefined : BigInt.asUintN(64, ret[1]);
    }
    /**
     * @returns {number | undefined}
     */
    get block_height() {
        const ret = wasm.transactionhistoryentry_block_height(this.__wbg_ptr);
        return ret === 0x100000001 ? undefined : ret;
    }
    /**
     * @returns {number}
     */
    get confirmations() {
        const ret = wasm.transactionhistoryentry_confirmations(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {TransactionStatusType}
     */
    get status() {
        const ret = wasm.transactionhistoryentry_status(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {string | undefined}
     */
    get memo() {
        const ret = wasm.transactionhistoryentry_memo(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * @returns {bigint | undefined}
     */
    get timestamp() {
        const ret = wasm.transactionhistoryentry_timestamp(this.__wbg_ptr);
        return ret[0] === 0 ? undefined : BigInt.asUintN(64, ret[1]);
    }
    /**
     * @returns {string}
     */
    get pool() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.transactionhistoryentry_pool(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}

const TransactionHistoryResponseFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_transactionhistoryresponse_free(ptr >>> 0, 1));
/**
 * Response containing paginated transaction history
 */
export class TransactionHistoryResponse {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(TransactionHistoryResponse.prototype);
        obj.__wbg_ptr = ptr;
        TransactionHistoryResponseFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    toJSON() {
        return {
            transactions: this.transactions,
            total_count: this.total_count,
            has_more: this.has_more,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TransactionHistoryResponseFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_transactionhistoryresponse_free(ptr, 0);
    }
    /**
     * @returns {any}
     */
    get transactions() {
        const ret = wasm.transactionhistoryresponse_transactions(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get total_count() {
        const ret = wasm.transactionhistoryresponse_total_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {boolean}
     */
    get has_more() {
        const ret = wasm.transactionhistoryresponse_has_more(this.__wbg_ptr);
        return ret !== 0;
    }
}

const UnifiedFullViewingKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_unifiedfullviewingkey_free(ptr >>> 0, 1));
/**
 * A Zcash viewing key
 *
 * This is a wrapper around the `zcash_keys::keys::ViewingKey` type.
 * UFVKs should be generated from a spending key by calling `to_unified_full_viewing_key`
 * They can also be encoded and decoded to a canonical string representation
 */
export class UnifiedFullViewingKey {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(UnifiedFullViewingKey.prototype);
        obj.__wbg_ptr = ptr;
        UnifiedFullViewingKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        UnifiedFullViewingKeyFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_unifiedfullviewingkey_free(ptr, 0);
    }
    /**
     * Encode the UFVK to a string
     *
     * # Arguments
     *
     * * `network` - Must be either "main" or "test"
     * @param {string} network
     * @returns {string}
     */
    encode(network) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(network, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.unifiedfullviewingkey_encode(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Construct a UFVK from its encoded string representation
     *
     * # Arguments
     *
     * * `network` - Must be either "main" or "test"
     * * `encoding` - The encoded string representation of the UFVK
     * @param {string} network
     * @param {string} encoding
     */
    constructor(network, encoding) {
        const ptr0 = passStringToWasm0(network, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(encoding, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.unifiedfullviewingkey_new(ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        UnifiedFullViewingKeyFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Get the default transparent address derived from this UFVK.
     *
     * This can be used before creating an account to detect the wallet birthday
     * by querying for transactions to this address.
     *
     * # Arguments
     *
     * * `network` - Must be either "main" or "test"
     *
     * # Returns
     *
     * The transparent address as a string, or None if this UFVK has no transparent component.
     * @param {string} network
     * @returns {string | undefined}
     */
    get_transparent_address(network) {
        const ptr0 = passStringToWasm0(network, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.unifiedfullviewingkey_get_transparent_address(this.__wbg_ptr, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        let v2;
        if (ret[0] !== 0) {
            v2 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v2;
    }
}

const UnifiedSpendingKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_unifiedspendingkey_free(ptr >>> 0, 1));
/**
 * A Zcash spending key
 *
 * This is a wrapper around the `zcash_keys::keys::SpendingKey` type. It can be created from at least 32 bytes of seed entropy
 */
export class UnifiedSpendingKey {

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        UnifiedSpendingKeyFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_unifiedspendingkey_free(ptr, 0);
    }
    /**
     * Construct a new UnifiedSpendingKey
     *
     * # Arguments
     *
     * * `network` - Must be either "main" or "test"
     * * `seed` - At least 32 bytes of entry. Care should be taken as to how this is derived
     * * `hd_index` - [ZIP32](https://zips.z.cash/zip-0032) hierarchical deterministic index of the account
     * @param {string} network
     * @param {Uint8Array} seed
     * @param {number} hd_index
     */
    constructor(network, seed, hd_index) {
        const ptr0 = passStringToWasm0(network, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(seed, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.unifiedspendingkey_new(ptr0, len0, ptr1, len1, hd_index);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        UnifiedSpendingKeyFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Obtain the UFVK corresponding to this spending key
     * @returns {UnifiedFullViewingKey}
     */
    to_unified_full_viewing_key() {
        const ret = wasm.unifiedspendingkey_to_unified_full_viewing_key(this.__wbg_ptr);
        return UnifiedFullViewingKey.__wrap(ret);
    }
    /**
     * @returns {ProofGenerationKey}
     */
    to_sapling_proof_generation_key() {
        const ret = wasm.unifiedspendingkey_to_sapling_proof_generation_key(this.__wbg_ptr);
        return ProofGenerationKey.__wrap(ret);
    }
}

const WalletSummaryFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_walletsummary_free(ptr >>> 0, 1));

export class WalletSummary {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(WalletSummary.prototype);
        obj.__wbg_ptr = ptr;
        WalletSummaryFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    toJSON() {
        return {
            chain_tip_height: this.chain_tip_height,
            fully_scanned_height: this.fully_scanned_height,
            next_sapling_subtree_index: this.next_sapling_subtree_index,
            next_orchard_subtree_index: this.next_orchard_subtree_index,
            next_ironwood_subtree_index: this.next_ironwood_subtree_index,
            account_balances: this.account_balances,
        };
    }

    toString() {
        return JSON.stringify(this);
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WalletSummaryFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_walletsummary_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get chain_tip_height() {
        const ret = wasm.__wbg_get_walletsummary_chain_tip_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set chain_tip_height(arg0) {
        wasm.__wbg_set_walletsummary_chain_tip_height(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get fully_scanned_height() {
        const ret = wasm.__wbg_get_walletsummary_fully_scanned_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} arg0
     */
    set fully_scanned_height(arg0) {
        wasm.__wbg_set_walletsummary_fully_scanned_height(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {bigint}
     */
    get next_sapling_subtree_index() {
        const ret = wasm.__wbg_get_walletsummary_next_sapling_subtree_index(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @param {bigint} arg0
     */
    set next_sapling_subtree_index(arg0) {
        wasm.__wbg_set_walletsummary_next_sapling_subtree_index(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {bigint}
     */
    get next_orchard_subtree_index() {
        const ret = wasm.__wbg_get_walletsummary_next_orchard_subtree_index(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @param {bigint} arg0
     */
    set next_orchard_subtree_index(arg0) {
        wasm.__wbg_set_walletsummary_next_orchard_subtree_index(this.__wbg_ptr, arg0);
    }
    /**
     * Stage 2.
     * @returns {bigint}
     */
    get next_ironwood_subtree_index() {
        const ret = wasm.__wbg_get_walletsummary_next_ironwood_subtree_index(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * Stage 2.
     * @param {bigint} arg0
     */
    set next_ironwood_subtree_index(arg0) {
        wasm.__wbg_set_walletsummary_next_ironwood_subtree_index(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {any}
     */
    get account_balances() {
        const ret = wasm.walletsummary_account_balances(this.__wbg_ptr);
        return ret;
    }
}

const WebWalletFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_webwallet_free(ptr >>> 0, 1));
/**
 * # A Zcash wallet
 *
 * This is the main entry point for interacting with this library.
 *
 * Stage 2 (ADR-018 § 3): the wallet database is the upstream SQLite wallet backend
 * (`zcash_client_sqlite`) running in WebAssembly; it tracks the Ironwood, Sapling, legacy Orchard
 * and transparent pools. The class name, methods and result shapes are those of the Stage-1
 * (Sapling beta) engine, with fields added (see API-v2.md).
 *
 * ```javascript
 * const wallet = new WebWallet("main", "https://…/zcash/lwd", 1, 1, savedBytesOrNull);
 * const accountId = await wallet.create_account("Zocial World", seedPhrase, 0, birthdayHeight);
 * await wallet.sync();
 * const balances = await wallet.get_balances(accountId);
 * const { txids } = await wallet.send(accountId, [{ to, amountZat, memo }], seedPhrase, 0);
 * const bytes = await wallet.db_to_bytes(); // persist
 * ```
 *
 * Accounts are numbered 0, 1, … in creation order. Syncing and proving run in Web Workers; other
 * calls made meanwhile wait for the wallet database (one lock).
 */
export class WebWallet {

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WebWalletFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_webwallet_free(ptr, 0);
    }
    /**
     * Create a new instance of a Zcash wallet for a given network.
     *
     * * `network` - "main" or "test" ("test" is the local regtest chain in the regtest twin build)
     * * `lightwalletd_url` - Url of the lightwalletd instance (the game server's bridge)
     * * `min_confirmations_trusted` / `min_confirmations_untrusted` - confirmations policy
     * * `db_bytes` - (Optional) the bytes of `db_to_bytes()` to restore a saved wallet. A Stage-1
     *   (memory backend) save, or damaged bytes, is refused with `wallet_format_unsupported`:
     *   restore the wallet from its seed phrase and birthday instead.
     * @param {string} network
     * @param {string} lightwalletd_url
     * @param {number} min_confirmations_trusted
     * @param {number} min_confirmations_untrusted
     * @param {Uint8Array | null} [db_bytes]
     */
    constructor(network, lightwalletd_url, min_confirmations_trusted, min_confirmations_untrusted, db_bytes) {
        const ptr0 = passStringToWasm0(network, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(lightwalletd_url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        var ptr2 = isLikeNone(db_bytes) ? 0 : passArray8ToWasm0(db_bytes, wasm.__wbindgen_malloc);
        var len2 = WASM_VECTOR_LEN;
        const ret = wasm.webwallet_new(ptr0, len0, ptr1, len1, min_confirmations_trusted, min_confirmations_untrusted, ptr2, len2);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        WebWalletFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * `"sqlite <version>"`: the wallet database backend, for diagnostics.
     * @returns {string}
     */
    static backend() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.webwallet_backend();
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Add a new account to the wallet using a given seed phrase; returns its numeric id
     * (creation order, from 0).
     *
     * * `seed_phrase` - 24 word mnemonic seed phrase
     * * `account_hd_index` - [ZIP32](https://zips.z.cash/zip-0032) index of the account
     * * `birthday_height` - Block height at which the account was created (scanning starts there)
     * @param {string} account_name
     * @param {string} seed_phrase
     * @param {number} account_hd_index
     * @param {number | null} [birthday_height]
     * @returns {Promise<number>}
     */
    create_account(account_name, seed_phrase, account_hd_index, birthday_height) {
        const ptr0 = passStringToWasm0(account_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(seed_phrase, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.webwallet_create_account(this.__wbg_ptr, ptr0, len0, ptr1, len1, account_hd_index, isLikeNone(birthday_height) ? 0x100000001 : (birthday_height) >>> 0);
        return ret;
    }
    /**
     * Add a new spending account by importing a Unified Full Viewing Key (UFVK); the matching
     * spending key must be supplied when sending.
     * @param {string} account_name
     * @param {string} encoded_ufvk
     * @param {SeedFingerprint} seed_fingerprint
     * @param {number} account_hd_index
     * @param {number | null} [birthday_height]
     * @returns {Promise<number>}
     */
    create_account_ufvk(account_name, encoded_ufvk, seed_fingerprint, account_hd_index, birthday_height) {
        const ptr0 = passStringToWasm0(account_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(encoded_ufvk, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        _assertClass(seed_fingerprint, SeedFingerprint);
        var ptr2 = seed_fingerprint.__destroy_into_raw();
        const ret = wasm.webwallet_create_account_ufvk(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, account_hd_index, isLikeNone(birthday_height) ? 0x100000001 : (birthday_height) >>> 0);
        return ret;
    }
    /**
     * Add a new view-only account by importing a Unified Full Viewing Key (UFVK).
     * @param {string} account_name
     * @param {string} encoded_ufvk
     * @param {number | null} [birthday_height]
     * @returns {Promise<number>}
     */
    create_account_view_ufvk(account_name, encoded_ufvk, birthday_height) {
        const ptr0 = passStringToWasm0(account_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(encoded_ufvk, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.webwallet_create_account_view_ufvk(this.__wbg_ptr, ptr0, len0, ptr1, len1, isLikeNone(birthday_height) ? 0x100000001 : (birthday_height) >>> 0);
        return ret;
    }
    /**
     * Syncs the wallet in a Web Worker: scans compact blocks to the chain tip through the game
     * server's bridge (Ironwood, Sapling and Orchard outputs are trial-decrypted, spends detected
     * by nullifier, transparent UTXOs refreshed), then fetches what the wallet still needs —
     * received memos and the status of sent transactions (`GetTransaction`), transparent history
     * (`GetTaddressTxids`) — checks the witnesses of spendable notes, and reconciles transparent
     * funds spent by another wallet with the same seed.
     * @returns {Promise<void>}
     */
    sync() {
        const ret = wasm.webwallet_sync(this.__wbg_ptr);
        return ret;
    }
    /**
     * The wallet summary (`account_balances` keyed by numeric account id).
     * @returns {Promise<WalletSummary | undefined>}
     */
    get_wallet_summary() {
        const ret = wasm.webwallet_get_wallet_summary(this.__wbg_ptr);
        return ret;
    }
    /**
     * Legacy API: a proposal paying one (non-withdrawal) output, under the Stage-2 pool policy
     * (an Orchard-family receiver gets an Ironwood output, else Sapling; change to Ironwood).
     * Prefer `send` / `preview_send`.
     * @param {number} account_id
     * @param {string} to_address
     * @param {bigint} value
     * @param {string | null} [memo]
     * @returns {Promise<Proposal>}
     */
    propose_transfer(account_id, to_address, value, memo) {
        const ptr0 = passStringToWasm0(to_address, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        var ptr1 = isLikeNone(memo) ? 0 : passStringToWasm0(memo, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len1 = WASM_VECTOR_LEN;
        const ret = wasm.webwallet_propose_transfer(this.__wbg_ptr, account_id, ptr0, len0, value, ptr1, len1);
        return ret;
    }
    /**
     * Legacy API: proves and signs the transactions of a `propose_transfer` proposal in a Web
     * Worker and stores them. Returns the txids flattened (32 bytes each, internal byte order).
     * @param {Proposal} proposal
     * @param {string} seed_phrase
     * @param {number} account_hd_index
     * @returns {Promise<Uint8Array>}
     */
    create_proposed_transactions(proposal, seed_phrase, account_hd_index) {
        _assertClass(proposal, Proposal);
        var ptr0 = proposal.__destroy_into_raw();
        const ptr1 = passStringToWasm0(seed_phrase, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.webwallet_create_proposed_transactions(this.__wbg_ptr, ptr0, ptr1, len1, account_hd_index);
        return ret;
    }
    /**
     * The wallet database as bytes — a SQLite database file — to persist and pass back to the
     * constructor. Taken under the wallet lock (waits for a running sync).
     * @returns {Promise<Uint8Array>}
     */
    db_to_bytes() {
        const ret = wasm.webwallet_db_to_bytes(this.__wbg_ptr);
        return ret;
    }
    /**
     * Legacy API: broadcasts transactions created by `create_proposed_transactions` (txids
     * flattened, 32 bytes each). Re-checks the consensus branch first.
     * @param {Uint8Array} txids
     * @returns {Promise<void>}
     */
    send_authorized_transactions(txids) {
        const ptr0 = passArray8ToWasm0(txids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.webwallet_send_authorized_transactions(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * The wallet's main receive address: the full unified address (Orchard-family receiver —
     * where Ironwood payments arrive — + Sapling + transparent), per the ADR-018 § 1 Stage 2
     * amendment. Same as `get_unified_address` and `get_addresses().unified`.
     * @param {number} account_id
     * @returns {Promise<string>}
     */
    get_current_address(account_id) {
        const ret = wasm.webwallet_get_current_address(this.__wbg_ptr, account_id);
        return ret;
    }
    /**
     * The full unified address (see `get_current_address`).
     * @param {number} account_id
     * @returns {Promise<string>}
     */
    get_unified_address(account_id) {
        const ret = wasm.webwallet_get_unified_address(this.__wbg_ptr, account_id);
        return ret;
    }
    /**
     * The same Sapling receiver in the plain Sapling encoding (`zs1…` on mainnet).
     * @param {number} account_id
     * @returns {Promise<string>}
     */
    get_sapling_address(account_id) {
        const ret = wasm.webwallet_get_sapling_address(this.__wbg_ptr, account_id);
        return ret;
    }
    /**
     * The plain transparent address (`t1…` on mainnet) of the same diversifier index: the
     * exchange address. Funds sent here are public and wait to be shielded (`shield` → Ironwood).
     * @param {number} account_id
     * @returns {Promise<string>}
     */
    get_transparent_address(account_id) {
        const ret = wasm.webwallet_get_transparent_address(this.__wbg_ptr, account_id);
        return ret;
    }
    /**
     * All receive addresses: `{ unified, unifiedShielded, unifiedSaplingTransparent, sapling,
     * transparent, diversifierIndex }`.
     * @param {number} account_id
     * @returns {WalletAddresses}
     */
    get_addresses(account_id) {
        const ret = wasm.webwallet_get_addresses(this.__wbg_ptr, account_id);
        return ret;
    }
    /**
     * Balances of every pool in zatoshis (Ironwood, Sapling, legacy Orchard, transparent; each
     * spendable / pending / total) plus `shieldedSpendableZat` (what `send` can use).
     * @param {number} account_id
     * @returns {WalletBalances}
     */
    get_balances(account_id) {
        const ret = wasm.webwallet_get_balances(this.__wbg_ptr, account_id);
        return ret;
    }
    /**
     * The upgrade guard, unchanged from Stage 1. Never throws; returns `{ allowed,
     * expectedBranch, chainBranch, chainName, chainTip, nextBlockBranch, pendingUpgrade, pools,
     * code, reason }`. When `allowed` is false every send/shield refuses with `code`
     * (`consensus_branch_mismatch`, `consensus_upgrade_pending` or `consensus_branch_unknown`),
     * while sync and balances keep working.
     * @returns {WalletSendingStatus}
     */
    sending_status() {
        const ret = wasm.webwallet_sending_status(this.__wbg_ptr);
        return ret;
    }
    /**
     * The ONE general send. Pays every output in a single version-6 transaction (a TEX
     * withdrawal takes two: shielded → ephemeral address → TEX), spending Ironwood, Sapling and
     * legacy Orchard notes with change to Ironwood, and broadcasts it. Proving runs in a Web
     * Worker.
     *
     * * `outputs` - `[{ to, amountZat, memo?, withdrawal? }]` (1–8). `to`: a unified address
     *   (Orchard-family receiver → Ironwood; else its Sapling receiver), a Sapling address, or —
     *   withdrawals only — a transparent or TEX address.
     *
     * Returns `{ txids, feeZat, amountZat, outputs: [{ to, pool, amountZat, hasMemo, tex }] }`.
     * Errors carry a stable `code` (see `sapling_beta_error_codes`).
     * @param {number} account_id
     * @param {WalletOutput[]} outputs
     * @param {string} seed_phrase
     * @param {number} account_hd_index
     * @returns {WalletSendResult}
     */
    send(account_id, outputs, seed_phrase, account_hd_index) {
        const ptr0 = passStringToWasm0(seed_phrase, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.webwallet_send(this.__wbg_ptr, account_id, outputs, ptr0, len0, account_hd_index);
        return ret;
    }
    /**
     * What `send` would do for these outputs — `{ txids: [], feeZat, amountZat, outputs }` —
     * without proving, signing or broadcasting. Use it to show the network fee.
     * @param {number} account_id
     * @param {WalletOutput[]} outputs
     * @returns {WalletSendResult}
     */
    preview_send(account_id, outputs) {
        const ret = wasm.webwallet_preview_send(this.__wbg_ptr, account_id, outputs);
        return ret;
    }
    /**
     * Shields the account's confirmed transparent funds into its own Ironwood address
     * (version-6 transaction, ZIP 317 network fee, no project fee) and broadcasts it.
     * `threshold_zat` (optional, default 1) is the minimum transparent input to shield.
     *
     * Returns `{ txid, utxos, transparentInZat, feeZat, shieldedZat, pool: "ironwood" }`.
     * @param {number} account_id
     * @param {string} seed_phrase
     * @param {number} account_hd_index
     * @param {bigint | null} [threshold_zat]
     * @returns {WalletShieldResult}
     */
    shield(account_id, seed_phrase, account_hd_index, threshold_zat) {
        const ptr0 = passStringToWasm0(seed_phrase, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.webwallet_shield(this.__wbg_ptr, account_id, ptr0, len0, account_hd_index, !isLikeNone(threshold_zat), isLikeNone(threshold_zat) ? BigInt(0) : threshold_zat);
        return ret;
    }
    /**
     * What `shield` would do — `{ txid: "", utxos, transparentInZat, feeZat, shieldedZat, pool }`
     * — without proving or broadcasting.
     * @param {number} account_id
     * @param {bigint | null} [threshold_zat]
     * @returns {WalletShieldResult}
     */
    preview_shield(account_id, threshold_zat) {
        const ret = wasm.webwallet_preview_shield(this.__wbg_ptr, account_id, !isLikeNone(threshold_zat), isLikeNone(threshold_zat) ? BigInt(0) : threshold_zat);
        return ret;
    }
    /**
     * Legacy PCZT path: a shielding PCZT (transparent → own Ironwood address, threshold
     * 100,000 zat). Then `pczt_sign` → `pczt_prove` → `pczt_send`. Prefer `shield`.
     * @param {number} account_id
     * @returns {Promise<Pczt>}
     */
    pczt_shield(account_id) {
        const ret = wasm.webwallet_pczt_shield(this.__wbg_ptr, account_id);
        return ret;
    }
    /**
     * Legacy PCZT path: a PCZT for one payment (Stage-2 pool policy, no withdrawals).
     * @param {number} account_id
     * @param {string} to_address
     * @param {bigint} value
     * @returns {Promise<Pczt>}
     */
    pczt_create(account_id, to_address, value) {
        const ptr0 = passStringToWasm0(to_address, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.webwallet_pczt_create(this.__wbg_ptr, account_id, ptr0, len0, value);
        return ret;
    }
    /**
     * Creates and inserts the Sapling, Orchard and Ironwood proofs of a PCZT. If there are
     * Sapling spends, a ProofGenerationKey must be supplied.
     * @param {Pczt} pczt
     * @param {ProofGenerationKey | null} [sapling_proof_gen_key]
     * @returns {Promise<Pczt>}
     */
    pczt_prove(pczt, sapling_proof_gen_key) {
        _assertClass(pczt, Pczt);
        var ptr0 = pczt.__destroy_into_raw();
        let ptr1 = 0;
        if (!isLikeNone(sapling_proof_gen_key)) {
            _assertClass(sapling_proof_gen_key, ProofGenerationKey);
            ptr1 = sapling_proof_gen_key.__destroy_into_raw();
        }
        const ret = wasm.webwallet_pczt_prove(this.__wbg_ptr, ptr0, ptr1);
        return ret;
    }
    /**
     * @param {Pczt} pczt
     * @returns {Promise<void>}
     */
    pczt_send(pczt) {
        _assertClass(pczt, Pczt);
        var ptr0 = pczt.__destroy_into_raw();
        const ret = wasm.webwallet_pczt_send(this.__wbg_ptr, ptr0);
        return ret;
    }
    /**
     * @param {Pczt[]} pczts
     * @returns {Pczt}
     */
    pczt_combine(pczts) {
        const ptr0 = passArrayJsValueToWasm0(pczts, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.webwallet_pczt_combine(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Pczt.__wrap(ret[0]);
    }
    /**
     * The transparent receiver of the account's receive address (same as
     * `get_transparent_address`; kept for the existing game code).
     * @param {number} account_id
     * @returns {Promise<string>}
     */
    get_current_address_transparent(account_id) {
        const ret = wasm.webwallet_get_current_address_transparent(this.__wbg_ptr, account_id);
        return ret;
    }
    /**
     * Transaction history of an account, newest first (unmined at the top), from the wallet
     * database's `v_transactions` / `v_tx_outputs` views.
     *
     * ```javascript
     * const history = await wallet.get_transaction_history(0, 50, 0);
     * console.log(history.transactions);
     * ```
     * @param {number} account_id
     * @param {number | null} [limit]
     * @param {number | null} [offset]
     * @returns {Promise<TransactionHistoryResponse>}
     */
    get_transaction_history(account_id, limit, offset) {
        const ret = wasm.webwallet_get_transaction_history(this.__wbg_ptr, account_id, isLikeNone(limit) ? 0x100000001 : (limit) >>> 0, isLikeNone(offset) ? 0x100000001 : (offset) >>> 0);
        return ret;
    }
    /**
     *
     * Get the highest known block height from the connected lightwalletd instance
     * @returns {Promise<bigint>}
     */
    get_latest_block() {
        const ret = wasm.webwallet_get_latest_block(this.__wbg_ptr);
        return ret;
    }
    /**
     * Detect the wallet birthday by querying for the first transaction to a transparent address.
     * Returns the earliest transaction height minus 100 blocks, or None.
     * @param {string} transparent_address
     * @returns {Promise<number | undefined>}
     */
    detect_birthday_from_transparent_address(transparent_address) {
        const ptr0 = passStringToWasm0(transparent_address, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.webwallet_detect_birthday_from_transparent_address(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
}

const wbg_rayon_PoolBuilderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wbg_rayon_poolbuilder_free(ptr >>> 0, 1));

export class wbg_rayon_PoolBuilder {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(wbg_rayon_PoolBuilder.prototype);
        obj.__wbg_ptr = ptr;
        wbg_rayon_PoolBuilderFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        wbg_rayon_PoolBuilderFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wbg_rayon_poolbuilder_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    numThreads() {
        const ret = wasm.wbg_rayon_poolbuilder_numThreads(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    receiver() {
        const ret = wasm.wbg_rayon_poolbuilder_receiver(this.__wbg_ptr);
        return ret >>> 0;
    }
    build() {
        wasm.wbg_rayon_poolbuilder_build(this.__wbg_ptr);
    }
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);

            } catch (e) {
                if (module.headers.get('Content-Type') != 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);

    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };

        } else {
            return instance;
        }
    }
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};
    imports.wbg.__wbg_String_8f0eb39a4a4c2f66 = function(arg0, arg1) {
        const ret = String(arg1);
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg_abort_410ec47a64ac6117 = function(arg0, arg1) {
        arg0.abort(arg1);
    };
    imports.wbg.__wbg_abort_775ef1d17fc65868 = function(arg0) {
        arg0.abort();
    };
    imports.wbg.__wbg_append_8c7dd8d641a5f01b = function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
        arg0.append(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4));
    }, arguments) };
    imports.wbg.__wbg_async_9ff6d9e405f13772 = function(arg0) {
        const ret = arg0.async;
        return ret;
    };
    imports.wbg.__wbg_body_0b8fd1fe671660df = function(arg0) {
        const ret = arg0.body;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_buffer_09165b52af8c5237 = function(arg0) {
        const ret = arg0.buffer;
        return ret;
    };
    imports.wbg.__wbg_buffer_609cc3eee51ed158 = function(arg0) {
        const ret = arg0.buffer;
        return ret;
    };
    imports.wbg.__wbg_byobRequest_77d9adf63337edfb = function(arg0) {
        const ret = arg0.byobRequest;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_byteLength_e674b853d9c77e1d = function(arg0) {
        const ret = arg0.byteLength;
        return ret;
    };
    imports.wbg.__wbg_byteOffset_fd862df290ef848d = function(arg0) {
        const ret = arg0.byteOffset;
        return ret;
    };
    imports.wbg.__wbg_call_672a4d21634d4a24 = function() { return handleError(function (arg0, arg1) {
        const ret = arg0.call(arg1);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_call_7cccdd69e0791ae2 = function() { return handleError(function (arg0, arg1, arg2) {
        const ret = arg0.call(arg1, arg2);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_cancel_8a308660caa6cadf = function(arg0) {
        const ret = arg0.cancel();
        return ret;
    };
    imports.wbg.__wbg_catch_a6e601879b2610e9 = function(arg0, arg1) {
        const ret = arg0.catch(arg1);
        return ret;
    };
    imports.wbg.__wbg_clearTimeout_2e2c4939388cdfbb = function(arg0) {
        const ret = clearTimeout(arg0);
        return ret;
    };
    imports.wbg.__wbg_close_304cc1fef3466669 = function() { return handleError(function (arg0) {
        arg0.close();
    }, arguments) };
    imports.wbg.__wbg_close_5ce03e29be453811 = function() { return handleError(function (arg0) {
        arg0.close();
    }, arguments) };
    imports.wbg.__wbg_createObjectURL_6e98d2f9c7bd9764 = function() { return handleError(function (arg0, arg1) {
        const ret = URL.createObjectURL(arg1);
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    }, arguments) };
    imports.wbg.__wbg_create_cfe43ccc88c64e0a = function(arg0) {
        const ret = Object.create(arg0);
        return ret;
    };
    imports.wbg.__wbg_crypto_86f2631e91b51511 = function(arg0) {
        const ret = arg0.crypto;
        return ret;
    };
    imports.wbg.__wbg_data_432d9c3df2630942 = function(arg0) {
        const ret = arg0.data;
        return ret;
    };
    imports.wbg.__wbg_debug_3cb59063b29f58c1 = function(arg0) {
        console.debug(arg0);
    };
    imports.wbg.__wbg_debug_e17b51583ca6a632 = function(arg0, arg1, arg2, arg3) {
        console.debug(arg0, arg1, arg2, arg3);
    };
    imports.wbg.__wbg_done_769e5ede4b31c67b = function(arg0) {
        const ret = arg0.done;
        return ret;
    };
    imports.wbg.__wbg_enqueue_bb16ba72f537dc9e = function() { return handleError(function (arg0, arg1) {
        arg0.enqueue(arg1);
    }, arguments) };
    imports.wbg.__wbg_error_524f506f44df1645 = function(arg0) {
        console.error(arg0);
    };
    imports.wbg.__wbg_error_7534b8e9a36f1ab4 = function(arg0, arg1) {
        let deferred0_0;
        let deferred0_1;
        try {
            deferred0_0 = arg0;
            deferred0_1 = arg1;
            console.error(getStringFromWasm0(arg0, arg1));
        } finally {
            wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
        }
    };
    imports.wbg.__wbg_error_80de38b3f7cc3c3c = function(arg0, arg1, arg2, arg3) {
        console.error(arg0, arg1, arg2, arg3);
    };
    imports.wbg.__wbg_eval_e10dc02e9547f640 = function() { return handleError(function (arg0, arg1) {
        const ret = eval(getStringFromWasm0(arg0, arg1));
        return ret;
    }, arguments) };
    imports.wbg.__wbg_fetch_07cd86dd296a5a63 = function(arg0, arg1, arg2) {
        const ret = arg0.fetch(arg1, arg2);
        return ret;
    };
    imports.wbg.__wbg_fetch_53eef7df7b439a49 = function(arg0, arg1) {
        const ret = fetch(arg0, arg1);
        return ret;
    };
    imports.wbg.__wbg_from_2a5d3e218e67aa85 = function(arg0) {
        const ret = Array.from(arg0);
        return ret;
    };
    imports.wbg.__wbg_getDate_ef336e14594b35ce = function(arg0) {
        const ret = arg0.getDate();
        return ret;
    };
    imports.wbg.__wbg_getDay_3da98b461c969439 = function(arg0) {
        const ret = arg0.getDay();
        return ret;
    };
    imports.wbg.__wbg_getFullYear_17d3c9e4db748eb7 = function(arg0) {
        const ret = arg0.getFullYear();
        return ret;
    };
    imports.wbg.__wbg_getHours_70451b8de3ce8638 = function(arg0) {
        const ret = arg0.getHours();
        return ret;
    };
    imports.wbg.__wbg_getMinutes_e793d718371e18f7 = function(arg0) {
        const ret = arg0.getMinutes();
        return ret;
    };
    imports.wbg.__wbg_getMonth_d37edcd23642c97d = function(arg0) {
        const ret = arg0.getMonth();
        return ret;
    };
    imports.wbg.__wbg_getRandomValues_552765c3ca2a1367 = function() { return handleError(function (arg0) {
        globalThis.crypto.getRandomValues(arg0);
    }, arguments) };
    imports.wbg.__wbg_getRandomValues_a5db668d7aa231b7 = function() { return handleError(function (arg0) {
        globalThis.crypto.getRandomValues(arg0);
    }, arguments) };
    imports.wbg.__wbg_getRandomValues_b3f15fcbfabb0f8b = function() { return handleError(function (arg0, arg1) {
        arg0.getRandomValues(arg1);
    }, arguments) };
    imports.wbg.__wbg_getReader_48e00749fe3f6089 = function() { return handleError(function (arg0) {
        const ret = arg0.getReader();
        return ret;
    }, arguments) };
    imports.wbg.__wbg_getSeconds_755197b634cca692 = function(arg0) {
        const ret = arg0.getSeconds();
        return ret;
    };
    imports.wbg.__wbg_getTime_46267b1c24877e30 = function(arg0) {
        const ret = arg0.getTime();
        return ret;
    };
    imports.wbg.__wbg_getTimezoneOffset_6b5752021c499c47 = function(arg0) {
        const ret = arg0.getTimezoneOffset();
        return ret;
    };
    imports.wbg.__wbg_get_67b2ba62fc30de12 = function() { return handleError(function (arg0, arg1) {
        const ret = Reflect.get(arg0, arg1);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_get_b9b93047fe3cf45b = function(arg0, arg1) {
        const ret = arg0[arg1 >>> 0];
        return ret;
    };
    imports.wbg.__wbg_getdone_d47073731acd3e74 = function(arg0) {
        const ret = arg0.done;
        return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
    };
    imports.wbg.__wbg_getvalue_009dcd63692bee1f = function(arg0) {
        const ret = arg0.value;
        return ret;
    };
    imports.wbg.__wbg_has_a5ea9117f258a0ec = function() { return handleError(function (arg0, arg1) {
        const ret = Reflect.has(arg0, arg1);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_headers_9cb51cfd2ac780a4 = function(arg0) {
        const ret = arg0.headers;
        return ret;
    };
    imports.wbg.__wbg_info_033d8b8a0838f1d3 = function(arg0, arg1, arg2, arg3) {
        console.info(arg0, arg1, arg2, arg3);
    };
    imports.wbg.__wbg_info_3daf2e093e091b66 = function(arg0) {
        console.info(arg0);
    };
    imports.wbg.__wbg_instanceof_DedicatedWorkerGlobalScope_a688e81380e34e02 = function(arg0) {
        let result;
        try {
            result = arg0 instanceof DedicatedWorkerGlobalScope;
        } catch (_) {
            result = false;
        }
        const ret = result;
        return ret;
    };
    imports.wbg.__wbg_instanceof_Window_def73ea0955fc569 = function(arg0) {
        let result;
        try {
            result = arg0 instanceof Window;
        } catch (_) {
            result = false;
        }
        const ret = result;
        return ret;
    };
    imports.wbg.__wbg_instanceof_WorkerGlobalScope_dbdbdea7e3b56493 = function(arg0) {
        let result;
        try {
            result = arg0 instanceof WorkerGlobalScope;
        } catch (_) {
            result = false;
        }
        const ret = result;
        return ret;
    };
    imports.wbg.__wbg_isArray_a1eab7e0d067391b = function(arg0) {
        const ret = Array.isArray(arg0);
        return ret;
    };
    imports.wbg.__wbg_iterator_9a24c88df860dc65 = function() {
        const ret = Symbol.iterator;
        return ret;
    };
    imports.wbg.__wbg_length_a446193dc22c12f8 = function(arg0) {
        const ret = arg0.length;
        return ret;
    };
    imports.wbg.__wbg_length_d56737991078581b = function(arg0) {
        const ret = arg0.length;
        return ret;
    };
    imports.wbg.__wbg_length_e2d2a49132c1b256 = function(arg0) {
        const ret = arg0.length;
        return ret;
    };
    imports.wbg.__wbg_log_c222819a41e063d3 = function(arg0) {
        console.log(arg0);
    };
    imports.wbg.__wbg_mark_05056c522bddc362 = function() { return handleError(function (arg0, arg1, arg2) {
        arg0.mark(getStringFromWasm0(arg1, arg2));
    }, arguments) };
    imports.wbg.__wbg_mark_24a1a597f4f00679 = function() { return handleError(function (arg0, arg1, arg2, arg3) {
        arg0.mark(getStringFromWasm0(arg1, arg2), arg3);
    }, arguments) };
    imports.wbg.__wbg_measure_0b7379f5cfacac6d = function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
        arg0.measure(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4), getStringFromWasm0(arg5, arg6));
    }, arguments) };
    imports.wbg.__wbg_measure_7728846525e2cced = function() { return handleError(function (arg0, arg1, arg2, arg3) {
        arg0.measure(getStringFromWasm0(arg1, arg2), arg3);
    }, arguments) };
    imports.wbg.__wbg_msCrypto_d562bbe83e0d4b91 = function(arg0) {
        const ret = arg0.msCrypto;
        return ret;
    };
    imports.wbg.__wbg_new0_f788a2397c7ca929 = function() {
        const ret = new Date();
        return ret;
    };
    imports.wbg.__wbg_new_018dcc2d6c8c2f6a = function() { return handleError(function () {
        const ret = new Headers();
        return ret;
    }, arguments) };
    imports.wbg.__wbg_new_23a2665fac83c611 = function(arg0, arg1) {
        try {
            var state0 = {a: arg0, b: arg1};
            var cb0 = (arg0, arg1) => {
                const a = state0.a;
                state0.a = 0;
                try {
                    return __wbg_adapter_444(a, state0.b, arg0, arg1);
                } finally {
                    state0.a = a;
                }
            };
            const ret = new Promise(cb0);
            return ret;
        } finally {
            state0.a = state0.b = 0;
        }
    };
    imports.wbg.__wbg_new_31a97dac4f10fab7 = function(arg0) {
        const ret = new Date(arg0);
        return ret;
    };
    imports.wbg.__wbg_new_405e22f390576ce2 = function() {
        const ret = new Object();
        return ret;
    };
    imports.wbg.__wbg_new_78feb108b6472713 = function() {
        const ret = new Array();
        return ret;
    };
    imports.wbg.__wbg_new_8a6f238a6ece86ea = function() {
        const ret = new Error();
        return ret;
    };
    imports.wbg.__wbg_new_a12002a7f91c75be = function(arg0) {
        const ret = new Uint8Array(arg0);
        return ret;
    };
    imports.wbg.__wbg_new_b1a33e5095abf678 = function() { return handleError(function (arg0, arg1) {
        const ret = new Worker(getStringFromWasm0(arg0, arg1));
        return ret;
    }, arguments) };
    imports.wbg.__wbg_new_c68d7209be747379 = function(arg0, arg1) {
        const ret = new Error(getStringFromWasm0(arg0, arg1));
        return ret;
    };
    imports.wbg.__wbg_new_e25e5aab09ff45db = function() { return handleError(function () {
        const ret = new AbortController();
        return ret;
    }, arguments) };
    imports.wbg.__wbg_new_e9a4a67dbababe57 = function(arg0) {
        const ret = new Int32Array(arg0);
        return ret;
    };
    imports.wbg.__wbg_newnoargs_105ed471475aaf50 = function(arg0, arg1) {
        const ret = new Function(getStringFromWasm0(arg0, arg1));
        return ret;
    };
    imports.wbg.__wbg_newwithbyteoffsetandlength_d97e637ebe145a9a = function(arg0, arg1, arg2) {
        const ret = new Uint8Array(arg0, arg1 >>> 0, arg2 >>> 0);
        return ret;
    };
    imports.wbg.__wbg_newwithlength_a381634e90c276d4 = function(arg0) {
        const ret = new Uint8Array(arg0 >>> 0);
        return ret;
    };
    imports.wbg.__wbg_newwithstrandinit_06c535e0a867c635 = function() { return handleError(function (arg0, arg1, arg2) {
        const ret = new Request(getStringFromWasm0(arg0, arg1), arg2);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_newwithstrsequence_a242b062eda81d0b = function() { return handleError(function (arg0) {
        const ret = new Blob(arg0);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_newwithyearmonthday_03748851282a850d = function(arg0, arg1, arg2) {
        const ret = new Date(arg0 >>> 0, arg1, arg2);
        return ret;
    };
    imports.wbg.__wbg_next_25feadfc0913fea9 = function(arg0) {
        const ret = arg0.next;
        return ret;
    };
    imports.wbg.__wbg_next_6574e1a8a62d1055 = function() { return handleError(function (arg0) {
        const ret = arg0.next();
        return ret;
    }, arguments) };
    imports.wbg.__wbg_node_e1f24f89a7336c2e = function(arg0) {
        const ret = arg0.node;
        return ret;
    };
    imports.wbg.__wbg_now_2f0bbf3fd348701f = function(arg0) {
        const ret = globalThis.performance.now();
        getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
    };
    imports.wbg.__wbg_now_807e54c39636c349 = function() {
        const ret = Date.now();
        return ret;
    };
    imports.wbg.__wbg_of_4a05197bfc89556f = function(arg0, arg1, arg2) {
        const ret = Array.of(arg0, arg1, arg2);
        return ret;
    };
    imports.wbg.__wbg_pczt_new = function(arg0) {
        const ret = Pczt.__wrap(arg0);
        return ret;
    };
    imports.wbg.__wbg_pczt_unwrap = function(arg0) {
        const ret = Pczt.__unwrap(arg0);
        return ret;
    };
    imports.wbg.__wbg_performance_121b9855d716e029 = function() {
        const ret = globalThis.performance;
        return ret;
    };
    imports.wbg.__wbg_postMessage_6edafa8f7b9c2f52 = function() { return handleError(function (arg0, arg1) {
        arg0.postMessage(arg1);
    }, arguments) };
    imports.wbg.__wbg_postMessage_83a8d58d3fcb6c13 = function() { return handleError(function (arg0, arg1) {
        arg0.postMessage(arg1);
    }, arguments) };
    imports.wbg.__wbg_process_3975fd6c72f520aa = function(arg0) {
        const ret = arg0.process;
        return ret;
    };
    imports.wbg.__wbg_proposal_new = function(arg0) {
        const ret = Proposal.__wrap(arg0);
        return ret;
    };
    imports.wbg.__wbg_push_737cfc8c1432c2c6 = function(arg0, arg1) {
        const ret = arg0.push(arg1);
        return ret;
    };
    imports.wbg.__wbg_queueMicrotask_97d92b4fcc8a61c5 = function(arg0) {
        queueMicrotask(arg0);
    };
    imports.wbg.__wbg_queueMicrotask_d3219def82552485 = function(arg0) {
        const ret = arg0.queueMicrotask;
        return ret;
    };
    imports.wbg.__wbg_randomFillSync_f8c153b79f285817 = function() { return handleError(function (arg0, arg1) {
        arg0.randomFillSync(arg1);
    }, arguments) };
    imports.wbg.__wbg_random_3ad904d98382defe = function() {
        const ret = Math.random();
        return ret;
    };
    imports.wbg.__wbg_read_a2434af1186cb56c = function(arg0) {
        const ret = arg0.read();
        return ret;
    };
    imports.wbg.__wbg_releaseLock_091899af97991d2e = function(arg0) {
        arg0.releaseLock();
    };
    imports.wbg.__wbg_require_b74f47fc2d022fd6 = function() { return handleError(function () {
        const ret = module.require;
        return ret;
    }, arguments) };
    imports.wbg.__wbg_resolve_4851785c9c5f573d = function(arg0) {
        const ret = Promise.resolve(arg0);
        return ret;
    };
    imports.wbg.__wbg_respond_1f279fa9f8edcb1c = function() { return handleError(function (arg0, arg1) {
        arg0.respond(arg1 >>> 0);
    }, arguments) };
    imports.wbg.__wbg_setTimeout_929c97a7c0f23d36 = function(arg0, arg1) {
        const ret = setTimeout(arg0, arg1);
        return ret;
    };
    imports.wbg.__wbg_set_11cd83f45504cedf = function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
        arg0.set(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4));
    }, arguments) };
    imports.wbg.__wbg_set_37837023f3d740e8 = function(arg0, arg1, arg2) {
        arg0[arg1 >>> 0] = arg2;
    };
    imports.wbg.__wbg_set_3f1d0b984ed272ed = function(arg0, arg1, arg2) {
        arg0[arg1] = arg2;
    };
    imports.wbg.__wbg_set_65595bdd868b3009 = function(arg0, arg1, arg2) {
        arg0.set(arg1, arg2 >>> 0);
    };
    imports.wbg.__wbg_set_bb8cecf6a62b9f46 = function() { return handleError(function (arg0, arg1, arg2) {
        const ret = Reflect.set(arg0, arg1, arg2);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_setbody_5923b78a95eedf29 = function(arg0, arg1) {
        arg0.body = arg1;
    };
    imports.wbg.__wbg_setcache_12f17c3a980650e4 = function(arg0, arg1) {
        arg0.cache = __wbindgen_enum_RequestCache[arg1];
    };
    imports.wbg.__wbg_setcredentials_c3a22f1cd105a2c6 = function(arg0, arg1) {
        arg0.credentials = __wbindgen_enum_RequestCredentials[arg1];
    };
    imports.wbg.__wbg_setheaders_834c0bdb6a8949ad = function(arg0, arg1) {
        arg0.headers = arg1;
    };
    imports.wbg.__wbg_setintegrity_564a2397cf837760 = function(arg0, arg1, arg2) {
        arg0.integrity = getStringFromWasm0(arg1, arg2);
    };
    imports.wbg.__wbg_setmethod_3c5280fe5d890842 = function(arg0, arg1, arg2) {
        arg0.method = getStringFromWasm0(arg1, arg2);
    };
    imports.wbg.__wbg_setmode_5dc300b865044b65 = function(arg0, arg1) {
        arg0.mode = __wbindgen_enum_RequestMode[arg1];
    };
    imports.wbg.__wbg_setname_73878b09a5ee3d0c = function(arg0, arg1, arg2) {
        arg0.name = getStringFromWasm0(arg1, arg2);
    };
    imports.wbg.__wbg_setonerror_57eeef5feb01fe7a = function(arg0, arg1) {
        arg0.onerror = arg1;
    };
    imports.wbg.__wbg_setonmessage_5a885b16bdc6dca6 = function(arg0, arg1) {
        arg0.onmessage = arg1;
    };
    imports.wbg.__wbg_setonmessageerror_9c25f59c328a0274 = function(arg0, arg1) {
        arg0.onmessageerror = arg1;
    };
    imports.wbg.__wbg_setredirect_40e6a7f717a2f86a = function(arg0, arg1) {
        arg0.redirect = __wbindgen_enum_RequestRedirect[arg1];
    };
    imports.wbg.__wbg_setreferrer_fea46c1230e5e29a = function(arg0, arg1, arg2) {
        arg0.referrer = getStringFromWasm0(arg1, arg2);
    };
    imports.wbg.__wbg_setreferrerpolicy_b73612479f761b6f = function(arg0, arg1) {
        arg0.referrerPolicy = __wbindgen_enum_ReferrerPolicy[arg1];
    };
    imports.wbg.__wbg_setsignal_75b21ef3a81de905 = function(arg0, arg1) {
        arg0.signal = arg1;
    };
    imports.wbg.__wbg_settype_47fae7d6c82625e7 = function(arg0, arg1) {
        arg0.type = __wbindgen_enum_WorkerType[arg1];
    };
    imports.wbg.__wbg_signal_aaf9ad74119f20a4 = function(arg0) {
        const ret = arg0.signal;
        return ret;
    };
    imports.wbg.__wbg_size_3808d41635a9c259 = function(arg0) {
        const ret = arg0.size;
        return ret;
    };
    imports.wbg.__wbg_slice_8c197bf0b6dfc84a = function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
        const ret = arg0.slice(arg1, arg2, getStringFromWasm0(arg3, arg4));
        return ret;
    }, arguments) };
    imports.wbg.__wbg_slice_972c243648c9fd2e = function(arg0, arg1, arg2) {
        const ret = arg0.slice(arg1 >>> 0, arg2 >>> 0);
        return ret;
    };
    imports.wbg.__wbg_stack_0ed75d68575b0f3c = function(arg0, arg1) {
        const ret = arg1.stack;
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg_startWorkers_2ca11761e08ff5d5 = function(arg0, arg1, arg2) {
        const ret = startWorkers(arg0, arg1, wbg_rayon_PoolBuilder.__wrap(arg2));
        return ret;
    };
    imports.wbg.__wbg_static_accessor_GLOBAL_88a902d13a557d07 = function() {
        const ret = typeof global === 'undefined' ? null : global;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_static_accessor_GLOBAL_THIS_56578be7e9f832b0 = function() {
        const ret = typeof globalThis === 'undefined' ? null : globalThis;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_static_accessor_SELF_37c5d418e4bf5819 = function() {
        const ret = typeof self === 'undefined' ? null : self;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_static_accessor_WINDOW_5de37043a91a9c40 = function() {
        const ret = typeof window === 'undefined' ? null : window;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_status_f6360336ca686bf0 = function(arg0) {
        const ret = arg0.status;
        return ret;
    };
    imports.wbg.__wbg_subarray_aa9065fa9dc5df96 = function(arg0, arg1, arg2) {
        const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
        return ret;
    };
    imports.wbg.__wbg_then_44b73946d2fb3e7d = function(arg0, arg1) {
        const ret = arg0.then(arg1);
        return ret;
    };
    imports.wbg.__wbg_then_48b406749878a531 = function(arg0, arg1, arg2) {
        const ret = arg0.then(arg1, arg2);
        return ret;
    };
    imports.wbg.__wbg_toString_5285597960676b7b = function(arg0) {
        const ret = arg0.toString();
        return ret;
    };
    imports.wbg.__wbg_toString_ba82658ec370add0 = function() { return handleError(function (arg0, arg1) {
        const ret = arg0.toString(arg1);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_toU8Slice_11519abfa5176ae4 = function(arg0, arg1, arg2, arg3) {
        JSArrayBufferCopy.toU8Slice(arg0, arg1, arg2 >>> 0, arg3 >>> 0);
    };
    imports.wbg.__wbg_transactionhistoryresponse_new = function(arg0) {
        const ret = TransactionHistoryResponse.__wrap(arg0);
        return ret;
    };
    imports.wbg.__wbg_value_cd1ffa7b1ab794f1 = function(arg0) {
        const ret = arg0.value;
        return ret;
    };
    imports.wbg.__wbg_value_dab73d3d5d4abaaf = function(arg0) {
        const ret = arg0.value;
        return ret;
    };
    imports.wbg.__wbg_versions_4e31226f5e8dc909 = function(arg0) {
        const ret = arg0.versions;
        return ret;
    };
    imports.wbg.__wbg_view_fd8a56e8983f448d = function(arg0) {
        const ret = arg0.view;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_waitAsync_61f0a081053dd3c2 = function(arg0, arg1, arg2) {
        const ret = Atomics.waitAsync(arg0, arg1 >>> 0, arg2);
        return ret;
    };
    imports.wbg.__wbg_waitAsync_7ce6c8a047c752c3 = function() {
        const ret = Atomics.waitAsync;
        return ret;
    };
    imports.wbg.__wbg_walletsummary_new = function(arg0) {
        const ret = WalletSummary.__wrap(arg0);
        return ret;
    };
    imports.wbg.__wbg_warn_4ca3906c248c47c4 = function(arg0) {
        console.warn(arg0);
    };
    imports.wbg.__wbg_warn_aaf1f4664a035bd6 = function(arg0, arg1, arg2, arg3) {
        console.warn(arg0, arg1, arg2, arg3);
    };
    imports.wbg.__wbindgen_bigint_from_i64 = function(arg0) {
        const ret = arg0;
        return ret;
    };
    imports.wbg.__wbindgen_bigint_from_u64 = function(arg0) {
        const ret = BigInt.asUintN(64, arg0);
        return ret;
    };
    imports.wbg.__wbindgen_bigint_get_as_i64 = function(arg0, arg1) {
        const v = arg1;
        const ret = typeof(v) === 'bigint' ? v : undefined;
        getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
    };
    imports.wbg.__wbindgen_boolean_get = function(arg0) {
        const v = arg0;
        const ret = typeof(v) === 'boolean' ? (v ? 1 : 0) : 2;
        return ret;
    };
    imports.wbg.__wbindgen_cb_drop = function(arg0) {
        const obj = arg0.original;
        if (obj.cnt-- == 1) {
            obj.a = 0;
            return true;
        }
        const ret = false;
        return ret;
    };
    imports.wbg.__wbindgen_closure_wrapper7837 = function(arg0, arg1, arg2) {
        const ret = makeMutClosure(arg0, arg1, 2912, __wbg_adapter_54);
        return ret;
    };
    imports.wbg.__wbindgen_closure_wrapper7839 = function(arg0, arg1, arg2) {
        const ret = makeMutClosure(arg0, arg1, 2912, __wbg_adapter_54);
        return ret;
    };
    imports.wbg.__wbindgen_closure_wrapper7875 = function(arg0, arg1, arg2) {
        const ret = makeMutClosure(arg0, arg1, 2926, __wbg_adapter_59);
        return ret;
    };
    imports.wbg.__wbindgen_closure_wrapper8018 = function(arg0, arg1, arg2) {
        const ret = makeMutClosure(arg0, arg1, 2983, __wbg_adapter_62);
        return ret;
    };
    imports.wbg.__wbindgen_closure_wrapper8020 = function(arg0, arg1, arg2) {
        const ret = makeMutClosure(arg0, arg1, 2983, __wbg_adapter_62);
        return ret;
    };
    imports.wbg.__wbindgen_debug_string = function(arg0, arg1) {
        const ret = debugString(arg1);
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbindgen_error_new = function(arg0, arg1) {
        const ret = new Error(getStringFromWasm0(arg0, arg1));
        return ret;
    };
    imports.wbg.__wbindgen_init_externref_table = function() {
        const table = wasm.__wbindgen_export_5;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
        ;
    };
    imports.wbg.__wbindgen_is_bigint = function(arg0) {
        const ret = typeof(arg0) === 'bigint';
        return ret;
    };
    imports.wbg.__wbindgen_is_function = function(arg0) {
        const ret = typeof(arg0) === 'function';
        return ret;
    };
    imports.wbg.__wbindgen_is_null = function(arg0) {
        const ret = arg0 === null;
        return ret;
    };
    imports.wbg.__wbindgen_is_object = function(arg0) {
        const val = arg0;
        const ret = typeof(val) === 'object' && val !== null;
        return ret;
    };
    imports.wbg.__wbindgen_is_string = function(arg0) {
        const ret = typeof(arg0) === 'string';
        return ret;
    };
    imports.wbg.__wbindgen_is_undefined = function(arg0) {
        const ret = arg0 === undefined;
        return ret;
    };
    imports.wbg.__wbindgen_jsval_eq = function(arg0, arg1) {
        const ret = arg0 === arg1;
        return ret;
    };
    imports.wbg.__wbindgen_link_9579f016b4522a24 = function(arg0) {
        const val = `onmessage = function (ev) {
            let [ia, index, value] = ev.data;
            ia = new Int32Array(ia.buffer);
            let result = Atomics.wait(ia, index, value);
            postMessage(result);
        };
        `;
        const ret = typeof URL.createObjectURL === 'undefined' ? "data:application/javascript," + encodeURIComponent(val) : URL.createObjectURL(new Blob([val], { type: "text/javascript" }));
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbindgen_memory = function() {
        const ret = wasm.memory;
        return ret;
    };
    imports.wbg.__wbindgen_module = function() {
        const ret = __wbg_init.__wbindgen_wasm_module;
        return ret;
    };
    imports.wbg.__wbindgen_number_get = function(arg0, arg1) {
        const obj = arg1;
        const ret = typeof(obj) === 'number' ? obj : undefined;
        getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
    };
    imports.wbg.__wbindgen_number_new = function(arg0) {
        const ret = arg0;
        return ret;
    };
    imports.wbg.__wbindgen_rethrow = function(arg0) {
        throw arg0;
    };
    imports.wbg.__wbindgen_string_get = function(arg0, arg1) {
        const obj = arg1;
        const ret = typeof(obj) === 'string' ? obj : undefined;
        var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbindgen_string_new = function(arg0, arg1) {
        const ret = getStringFromWasm0(arg0, arg1);
        return ret;
    };
    imports.wbg.__wbindgen_throw = function(arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
    };
    imports.wbg.__wbindgen_uint8_array_new = function(arg0, arg1) {
        var v0 = getArrayU8FromWasm0(arg0, arg1).slice();
        wasm.__wbindgen_free(arg0, arg1 * 1, 1);
        const ret = v0;
        return ret;
    };
    imports['./snippets/wasm_thread-8ee53d0673203880/src/wasm32/js/module_worker_start.js'] = __wbg_star0;
    imports['./snippets/wasm_thread-8ee53d0673203880/src/wasm32/js/module_workers_polyfill.min.js'] = __wbg_star1;

    return imports;
}

function __wbg_init_memory(imports, memory) {
    imports.wbg.memory = memory || new WebAssembly.Memory({initial:841,maximum:16384,shared:true});
}

function __wbg_finalize_init(instance, module, thread_stack_size) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;

    if (typeof thread_stack_size !== 'undefined' && (typeof thread_stack_size !== 'number' || thread_stack_size === 0 || thread_stack_size % 65536 !== 0)) { throw 'invalid stack size' }
    wasm.__wbindgen_start(thread_stack_size);
    return wasm;
}

function initSync(module, memory) {
    if (wasm !== undefined) return wasm;

    let thread_stack_size
    if (typeof module !== 'undefined') {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module, memory, thread_stack_size} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();

    __wbg_init_memory(imports, memory);

    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }

    const instance = new WebAssembly.Instance(module, imports);

    return __wbg_finalize_init(instance, module, thread_stack_size);
}

async function __wbg_init(module_or_path, memory) {
    if (wasm !== undefined) return wasm;

    let thread_stack_size
    if (typeof module_or_path !== 'undefined') {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path, memory, thread_stack_size} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (typeof module_or_path === 'undefined') {
        module_or_path = new URL('webzjs_wallet_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    __wbg_init_memory(imports, memory);

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module, thread_stack_size);
}

export { initSync };
export default __wbg_init;
