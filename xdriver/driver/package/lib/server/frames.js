"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var frames_exports = {};
__export(frames_exports, {
  Frame: () => Frame,
  FrameManager: () => FrameManager,
  NavigationAbortedError: () => NavigationAbortedError
});
module.exports = __toCommonJS(frames_exports);
var import_crExecutionContext = require("./chromium/crExecutionContext");
var import_dom = require("./dom");
var import_crypto = __toESM(require("crypto"));
var import_browserContext = require("./browserContext");
var dom = __toESM(require("./dom"));
var import_errors = require("./errors");
var import_fileUploadUtils = require("./fileUploadUtils");
var import_frameSelectors = require("./frameSelectors");
var import_helper = require("./helper");
var import_instrumentation = require("./instrumentation");
var js = __toESM(require("./javascript"));
var network = __toESM(require("./network"));
var import_page = require("./page");
var import_progress = require("./progress");
var types = __toESM(require("./types"));
var import_utils = require("../utils");
var import_protocolError = require("./protocolError");
var import_debugLogger = require("./utils/debugLogger");
var import_eventsHelper = require("./utils/eventsHelper");
var import_selectorParser = require("../utils/isomorphic/selectorParser");
var import_manualPromise = require("../utils/isomorphic/manualPromise");
var import_callLog = require("./callLog");
class NavigationAbortedError extends Error {
  constructor(documentId, message) {
    super(message);
    this.documentId = documentId;
  }
}
const kDummyFrameId = "<dummy>";
class FrameManager {
  constructor(page) {
    this._frames = /* @__PURE__ */ new Map();
    this._consoleMessageTags = /* @__PURE__ */ new Map();
    this._signalBarriers = /* @__PURE__ */ new Set();
    this._webSockets = /* @__PURE__ */ new Map();
    this._openedDialogs = /* @__PURE__ */ new Set();
    this._closeAllOpeningDialogs = false;
    this._page = page;
    this._mainFrame = void 0;
  }
  createDummyMainFrameIfNeeded() {
    if (!this._mainFrame)
      this.frameAttached(kDummyFrameId, null);
  }
  dispose() {
    for (const frame of this._frames.values()) {
      frame._stopNetworkIdleTimer();
      frame._invalidateNonStallingEvaluations("Target crashed");
    }
  }
  mainFrame() {
    return this._mainFrame;
  }
  frames() {
    const frames = [];
    collect(this._mainFrame);
    return frames;
    function collect(frame) {
      frames.push(frame);
      for (const subframe of frame.childFrames())
        collect(subframe);
    }
  }
  frame(frameId) {
    return this._frames.get(frameId) || null;
  }
  frameAttached(frameId, parentFrameId) {
    const parentFrame = parentFrameId ? this._frames.get(parentFrameId) : null;
    if (!parentFrame) {
      if (this._mainFrame) {
        this._frames.delete(this._mainFrame._id);
        this._mainFrame._id = frameId;
      } else {
        (0, import_utils.assert)(!this._frames.has(frameId));
        this._mainFrame = new Frame(this._page, frameId, parentFrame);
      }
      this._frames.set(frameId, this._mainFrame);
      return this._mainFrame;
    } else {
      (0, import_utils.assert)(!this._frames.has(frameId));
      const frame = new Frame(this._page, frameId, parentFrame);
      this._frames.set(frameId, frame);
      this._page.emit(import_page.Page.Events.FrameAttached, frame);
      return frame;
    }
  }
  async waitForSignalsCreatedBy(progress, waitAfter, action) {
    if (!waitAfter)
      return action();
    const barrier = new SignalBarrier(progress);
    this._signalBarriers.add(barrier);
    if (progress)
      progress.cleanupWhenAborted(() => this._signalBarriers.delete(barrier));
    const result = await action();
    await this._page._delegate.inputActionEpilogue();
    await barrier.waitFor();
    this._signalBarriers.delete(barrier);
    await new Promise((0, import_utils.makeWaitForNextTask)());
    return result;
  }
  frameWillPotentiallyRequestNavigation() {
    for (const barrier of this._signalBarriers)
      barrier.retain();
  }
  frameDidPotentiallyRequestNavigation() {
    for (const barrier of this._signalBarriers)
      barrier.release();
  }
  frameRequestedNavigation(frameId, documentId) {
    const frame = this._frames.get(frameId);
    if (!frame)
      return;
    for (const barrier of this._signalBarriers)
      barrier.addFrameNavigation(frame);
    if (frame.pendingDocument() && frame.pendingDocument().documentId === documentId) {
      return;
    }
    const request = documentId ? Array.from(frame._inflightRequests).find((request2) => request2._documentId === documentId) : void 0;
    frame.setPendingDocument({ documentId, request });
  }
  frameCommittedNewDocumentNavigation(frameId, url, name, documentId, initial) {
    const frame = this._frames.get(frameId);
    this.removeChildFramesRecursively(frame);
    this.clearWebSockets(frame);
    frame._url = url;
    frame._name = name;
    let keepPending;
    const pendingDocument = frame.pendingDocument();
    if (pendingDocument) {
      if (pendingDocument.documentId === void 0) {
        pendingDocument.documentId = documentId;
      }
      if (pendingDocument.documentId === documentId) {
        frame._currentDocument = pendingDocument;
      } else {
        keepPending = pendingDocument;
        frame._currentDocument = { documentId, request: void 0 };
      }
      frame.setPendingDocument(void 0);
    } else {
      frame._currentDocument = { documentId, request: void 0 };
    }
    frame._onClearLifecycle();
    const navigationEvent = { url, name, newDocument: frame._currentDocument, isPublic: true };
    this._fireInternalFrameNavigation(frame, navigationEvent);
    if (!initial) {
      import_debugLogger.debugLogger.log("api", `  navigated to "${url}"`);
      this._page.frameNavigatedToNewDocument(frame);
    }
    frame.setPendingDocument(keepPending);
  }
  frameCommittedSameDocumentNavigation(frameId, url) {
    const frame = this._frames.get(frameId);
    if (!frame)
      return;
    const pending = frame.pendingDocument();
    if (pending && pending.documentId === void 0 && pending.request === void 0) {
      frame.setPendingDocument(void 0);
    }
    frame._url = url;
    const navigationEvent = { url, name: frame._name, isPublic: true };
    this._fireInternalFrameNavigation(frame, navigationEvent);
    import_debugLogger.debugLogger.log("api", `  navigated to "${url}"`);
  }
  frameAbortedNavigation(frameId, errorText, documentId) {
    const frame = this._frames.get(frameId);
    if (!frame || !frame.pendingDocument())
      return;
    if (documentId !== void 0 && frame.pendingDocument().documentId !== documentId)
      return;
    const navigationEvent = {
      url: frame._url,
      name: frame._name,
      newDocument: frame.pendingDocument(),
      error: new NavigationAbortedError(documentId, errorText),
      isPublic: !(documentId && frame._redirectedNavigations.has(documentId))
    };
    frame.setPendingDocument(void 0);
    this._fireInternalFrameNavigation(frame, navigationEvent);
  }
  frameDetached(frameId) {
    const frame = this._frames.get(frameId);
    if (frame) {
      this._removeFramesRecursively(frame);
      this._page.mainFrame()._recalculateNetworkIdle();
    }
  }
  frameLifecycleEvent(frameId, event) {
    const frame = this._frames.get(frameId);
    if (frame)
      frame._onLifecycleEvent(event);
  }
  requestStarted(request, route) {
    const frame = request.frame();
    this._inflightRequestStarted(request);
    if (request._documentId)
      frame.setPendingDocument({ documentId: request._documentId, request });
    if (request._isFavicon) {
      route?.abort("aborted").catch(() => {
      });
      return;
    }
    this._page.emitOnContext(import_browserContext.BrowserContext.Events.Request, request);
    if (route) {
      const r = new network.Route(request, route);
      if (this._page._serverRequestInterceptor?.(r, request))
        return;
      if (this._page._clientRequestInterceptor?.(r, request))
        return;
      if (this._page._browserContext._requestInterceptor?.(r, request))
        return;
      r.continue({ isFallback: true }).catch(() => {
      });
    }
  }
  requestReceivedResponse(response) {
    if (response.request()._isFavicon)
      return;
    this._page.emitOnContext(import_browserContext.BrowserContext.Events.Response, response);
  }
  reportRequestFinished(request, response) {
    this._inflightRequestFinished(request);
    if (request._isFavicon)
      return;
    this._page.emitOnContext(import_browserContext.BrowserContext.Events.RequestFinished, { request, response });
  }
  requestFailed(request, canceled) {
    const frame = request.frame();
    this._inflightRequestFinished(request);
    if (frame.pendingDocument() && frame.pendingDocument().request === request) {
      let errorText = request.failure().errorText;
      if (canceled)
        errorText += "; maybe frame was detached?";
      this.frameAbortedNavigation(frame._id, errorText, frame.pendingDocument().documentId);
    }
    if (request._isFavicon)
      return;
    this._page.emitOnContext(import_browserContext.BrowserContext.Events.RequestFailed, request);
  }
  dialogDidOpen(dialog) {
    for (const frame of this._frames.values())
      frame._invalidateNonStallingEvaluations("JavaScript dialog interrupted evaluation");
    if (this._closeAllOpeningDialogs)
      dialog.close().then(() => {
      });
    else
      this._openedDialogs.add(dialog);
  }
  dialogWillClose(dialog) {
    this._openedDialogs.delete(dialog);
  }
  async closeOpenDialogs() {
    await Promise.all([...this._openedDialogs].map((dialog) => dialog.close())).catch(() => {
    });
    this._openedDialogs.clear();
  }
  setCloseAllOpeningDialogs(closeDialogs) {
    this._closeAllOpeningDialogs = closeDialogs;
  }
  removeChildFramesRecursively(frame) {
    for (const child of frame.childFrames())
      this._removeFramesRecursively(child);
  }
  _removeFramesRecursively(frame) {
    this.removeChildFramesRecursively(frame);
    frame._onDetached();
    this._frames.delete(frame._id);
    if (!this._page.isClosed())
      this._page.emit(import_page.Page.Events.FrameDetached, frame);
  }
  _inflightRequestFinished(request) {
    const frame = request.frame();
    if (request._isFavicon)
      return;
    if (!frame._inflightRequests.has(request))
      return;
    frame._inflightRequests.delete(request);
    if (frame._inflightRequests.size === 0)
      frame._startNetworkIdleTimer();
  }
  _inflightRequestStarted(request) {
    const frame = request.frame();
    if (request._isFavicon)
      return;
    frame._inflightRequests.add(request);
    if (frame._inflightRequests.size === 1)
      frame._stopNetworkIdleTimer();
  }
  interceptConsoleMessage(message) {
    if (message.type() !== "debug")
      return false;
    const tag = message.text();
    const handler = this._consoleMessageTags.get(tag);
    if (!handler)
      return false;
    this._consoleMessageTags.delete(tag);
    handler();
    return true;
  }
  clearWebSockets(frame) {
    if (frame.parentFrame())
      return;
    this._webSockets.clear();
  }
  onWebSocketCreated(requestId, url) {
    const ws = new network.WebSocket(this._page, url);
    this._webSockets.set(requestId, ws);
  }
  onWebSocketRequest(requestId) {
    const ws = this._webSockets.get(requestId);
    if (ws && ws.markAsNotified())
      this._page.emit(import_page.Page.Events.WebSocket, ws);
  }
  onWebSocketResponse(requestId, status, statusText) {
    const ws = this._webSockets.get(requestId);
    if (status < 400)
      return;
    if (ws)
      ws.error(`${statusText}: ${status}`);
  }
  onWebSocketFrameSent(requestId, opcode, data) {
    const ws = this._webSockets.get(requestId);
    if (ws)
      ws.frameSent(opcode, data);
  }
  webSocketFrameReceived(requestId, opcode, data) {
    const ws = this._webSockets.get(requestId);
    if (ws)
      ws.frameReceived(opcode, data);
  }
  webSocketClosed(requestId) {
    const ws = this._webSockets.get(requestId);
    if (ws)
      ws.closed();
    this._webSockets.delete(requestId);
  }
  webSocketError(requestId, errorMessage) {
    const ws = this._webSockets.get(requestId);
    if (ws)
      ws.error(errorMessage);
  }
  _fireInternalFrameNavigation(frame, event) {
    frame.emit(Frame.Events.InternalNavigation, event);
  }
}
class Frame extends import_instrumentation.SdkObject {
  constructor(page, id, parentFrame) {
    super(page, "frame");
    this._firedLifecycleEvents = /* @__PURE__ */ new Set();
    this._firedNetworkIdleSelf = false;
    this._url = "";
    this._contextData = /* @__PURE__ */ new Map();
    this._childFrames = /* @__PURE__ */ new Set();
    this._name = "";
    this._inflightRequests = /* @__PURE__ */ new Set();
    this._setContentCounter = 0;
    this._detachedScope = new import_utils.LongStandingScope();
    this._raceAgainstEvaluationStallingEventsPromises = /* @__PURE__ */ new Set();
    this._redirectedNavigations = /* @__PURE__ */ new Map();
    this.attribution.frame = this;
    this._id = id;
    this._page = page;
    this._parentFrame = parentFrame;
    this._currentDocument = { documentId: void 0, request: void 0 };
    this.selectors = new import_frameSelectors.FrameSelectors(this);
    this._contextData.set("main", { contextPromise: new import_manualPromise.ManualPromise(), context: null });
    this._contextData.set("utility", { contextPromise: new import_manualPromise.ManualPromise(), context: null });
    this._setContext("main", null);
    this._setContext("utility", null);
    if (this._parentFrame)
      this._parentFrame._childFrames.add(this);
    this._firedLifecycleEvents.add("commit");
    if (id !== kDummyFrameId)
      this._startNetworkIdleTimer();
  }
  static {
    this.Events = {
      InternalNavigation: "internalnavigation",
      AddLifecycle: "addlifecycle",
      RemoveLifecycle: "removelifecycle"
    };
  }
  isDetached() {
    return this._detachedScope.isClosed();
  }
  _onLifecycleEvent(event) {
    if (this._firedLifecycleEvents.has(event))
      return;
    this._firedLifecycleEvents.add(event);
    this.emit(Frame.Events.AddLifecycle, event);
    if (this === this._page.mainFrame() && this._url !== "about:blank")
      import_debugLogger.debugLogger.log("api", `  "${event}" event fired`);
    this._page.mainFrame()._recalculateNetworkIdle();
  }
  _onClearLifecycle() {
    this._isolatedWorld = void 0;
    this._mainWorld = void 0;
    this._iframeWorld = void 0;
    for (const event of this._firedLifecycleEvents)
      this.emit(Frame.Events.RemoveLifecycle, event);
    this._firedLifecycleEvents.clear();
    this._inflightRequests = new Set(Array.from(this._inflightRequests).filter((request) => request === this._currentDocument.request));
    this._stopNetworkIdleTimer();
    if (this._inflightRequests.size === 0)
      this._startNetworkIdleTimer();
    this._page.mainFrame()._recalculateNetworkIdle(this);
    this._onLifecycleEvent("commit");
  }
  setPendingDocument(documentInfo) {
    this._pendingDocument = documentInfo;
    if (documentInfo)
      this._invalidateNonStallingEvaluations("Navigation interrupted the evaluation");
  }
  pendingDocument() {
    return this._pendingDocument;
  }
  _invalidateNonStallingEvaluations(message) {
    if (!this._raceAgainstEvaluationStallingEventsPromises.size)
      return;
    const error = new Error(message);
    for (const promise of this._raceAgainstEvaluationStallingEventsPromises)
      promise.reject(error);
  }
  async raceAgainstEvaluationStallingEvents(cb) {
    if (this._pendingDocument)
      throw new Error("Frame is currently attempting a navigation");
    if (this._page._frameManager._openedDialogs.size)
      throw new Error("Open JavaScript dialog prevents evaluation");
    const promise = new import_manualPromise.ManualPromise();
    this._raceAgainstEvaluationStallingEventsPromises.add(promise);
    try {
      return await Promise.race([
        cb(),
        promise
      ]);
    } finally {
      this._raceAgainstEvaluationStallingEventsPromises.delete(promise);
    }
  }
  nonStallingRawEvaluateInExistingMainContext(expression) {
    return this.raceAgainstEvaluationStallingEvents(() => {
      const context = this._existingMainContext();
      if (!context)
        throw new Error("Frame does not yet have a main execution context");
      return context.rawEvaluateJSON(expression);
    });
  }
  nonStallingEvaluateInExistingContext(expression, world) {
    return this.raceAgainstEvaluationStallingEvents(() => {
      const context = this._contextData.get(world)?.context;
      if (!context)
        throw new Error("Frame does not yet have the execution context");
      return context.evaluateExpression(expression, { isFunction: false });
    });
  }
  _recalculateNetworkIdle(frameThatAllowsRemovingNetworkIdle) {
    let isNetworkIdle = this._firedNetworkIdleSelf;
    for (const child of this._childFrames) {
      child._recalculateNetworkIdle(frameThatAllowsRemovingNetworkIdle);
      if (!child._firedLifecycleEvents.has("networkidle"))
        isNetworkIdle = false;
    }
    if (isNetworkIdle && !this._firedLifecycleEvents.has("networkidle")) {
      this._firedLifecycleEvents.add("networkidle");
      this.emit(Frame.Events.AddLifecycle, "networkidle");
      if (this === this._page.mainFrame() && this._url !== "about:blank")
        import_debugLogger.debugLogger.log("api", `  "networkidle" event fired`);
    }
    if (frameThatAllowsRemovingNetworkIdle !== this && this._firedLifecycleEvents.has("networkidle") && !isNetworkIdle) {
      this._firedLifecycleEvents.delete("networkidle");
      this.emit(Frame.Events.RemoveLifecycle, "networkidle");
    }
  }
  async raceNavigationAction(progress, options, action) {
    return import_utils.LongStandingScope.raceMultiple([
      this._detachedScope,
      this._page.openScope
    ], action().catch((e) => {
      if (e instanceof NavigationAbortedError && e.documentId) {
        const data = this._redirectedNavigations.get(e.documentId);
        if (data) {
          progress.log(`waiting for redirected navigation to "${data.url}"`);
          return data.gotoPromise;
        }
      }
      throw e;
    }));
  }
  redirectNavigation(url, documentId, referer) {
    const controller = new import_progress.ProgressController((0, import_instrumentation.serverSideCallMetadata)(), this);
    const data = {
      url,
      gotoPromise: controller.run((progress) => this._gotoAction(progress, url, { referer }), 0)
    };
    this._redirectedNavigations.set(documentId, data);
    data.gotoPromise.finally(() => this._redirectedNavigations.delete(documentId));
  }
  async goto(metadata, url, options = {}) {
    const constructedNavigationURL = (0, import_utils.constructURLBasedOnBaseURL)(this._page._browserContext._options.baseURL, url);
    const controller = new import_progress.ProgressController(metadata, this);
    return controller.run((progress) => this._goto(progress, constructedNavigationURL, options), this._page._timeoutSettings.navigationTimeout(options));
  }
  async _goto(progress, url, options) {
    return this.raceNavigationAction(progress, options, async () => this._gotoAction(progress, url, options));
  }
  async _gotoAction(progress, url, options) {
    const waitUntil = verifyLifecycle("waitUntil", options.waitUntil === void 0 ? "load" : options.waitUntil);
    progress.log(`navigating to "${url}", waiting until "${waitUntil}"`);
    const headers = this._page.extraHTTPHeaders() || [];
    const refererHeader = headers.find((h) => h.name.toLowerCase() === "referer");
    let referer = refererHeader ? refererHeader.value : void 0;
    if (options.referer !== void 0) {
      if (referer !== void 0 && referer !== options.referer)
        throw new Error('"referer" is already specified as extra HTTP header');
      referer = options.referer;
    }
    url = import_helper.helper.completeUserURL(url);
    const navigationEvents = [];
    const collectNavigations = (arg) => navigationEvents.push(arg);
    this.on(Frame.Events.InternalNavigation, collectNavigations);
    const navigateResult = await this._page._delegate.navigateFrame(this, url, referer).finally(
      () => this.off(Frame.Events.InternalNavigation, collectNavigations)
    );
    let event;
    if (navigateResult.newDocumentId) {
      const predicate = (event2) => {
        return event2.newDocument && (event2.newDocument.documentId === navigateResult.newDocumentId || !event2.error);
      };
      const events = navigationEvents.filter(predicate);
      if (events.length)
        event = events[0];
      else
        event = await import_helper.helper.waitForEvent(progress, this, Frame.Events.InternalNavigation, predicate).promise;
      if (event.newDocument.documentId !== navigateResult.newDocumentId) {
        throw new NavigationAbortedError(navigateResult.newDocumentId, `Navigation to "${url}" is interrupted by another navigation to "${event.url}"`);
      }
      if (event.error)
        throw event.error;
    } else {
      const predicate = (e) => !e.newDocument;
      const events = navigationEvents.filter(predicate);
      if (events.length)
        event = events[0];
      else
        event = await import_helper.helper.waitForEvent(progress, this, Frame.Events.InternalNavigation, predicate).promise;
    }
    if (!this._firedLifecycleEvents.has(waitUntil))
      await import_helper.helper.waitForEvent(progress, this, Frame.Events.AddLifecycle, (e) => e === waitUntil).promise;
    const request = event.newDocument ? event.newDocument.request : void 0;
    const response = request ? request._finalRequest().response() : null;
    return response;
  }
  async _waitForNavigation(progress, requiresNewDocument, options) {
    const waitUntil = verifyLifecycle("waitUntil", options.waitUntil === void 0 ? "load" : options.waitUntil);
    progress.log(`waiting for navigation until "${waitUntil}"`);
    const navigationEvent = await import_helper.helper.waitForEvent(progress, this, Frame.Events.InternalNavigation, (event) => {
      if (event.error)
        return true;
      if (requiresNewDocument && !event.newDocument)
        return false;
      progress.log(`  navigated to "${this._url}"`);
      return true;
    }).promise;
    if (navigationEvent.error)
      throw navigationEvent.error;
    if (!this._firedLifecycleEvents.has(waitUntil))
      await import_helper.helper.waitForEvent(progress, this, Frame.Events.AddLifecycle, (e) => e === waitUntil).promise;
    const request = navigationEvent.newDocument ? navigationEvent.newDocument.request : void 0;
    return request ? request._finalRequest().response() : null;
  }
  async _waitForLoadState(progress, state) {
    const waitUntil = verifyLifecycle("state", state);
    if (!this._firedLifecycleEvents.has(waitUntil))
      await import_helper.helper.waitForEvent(progress, this, Frame.Events.AddLifecycle, (e) => e === waitUntil).promise;
  }
  async frameElement() {
    return this._page._delegate.getFrameElement(this);
  }
  async _context(world) {
    try {
      var client = this._page._delegate._sessionForFrame(this)._client;
    } catch (e) {
      var client = this._page._delegate._mainFrameSession._client;
    }
    var iframeExecutionContextId = await this._getFrameMainFrameContextId(client);
    if (world == "main") {
      if (this != this._page.mainFrame() && iframeExecutionContextId && this._iframeWorld == void 0) {
        var executionContextId = iframeExecutionContextId;
        var crContext = new import_crExecutionContext.CRExecutionContext(client, { id: executionContextId }, this._id);
        this._iframeWorld = new import_dom.FrameExecutionContext(crContext, this, world);
        this._page._delegate._mainFrameSession._onExecutionContextCreated({
          id: executionContextId,
          origin: world,
          name: world,
          auxData: { isDefault: this === this._page.mainFrame(), type: "isolated", frameId: this._id }
        });
      } else if (this._mainWorld == void 0) {
        var globalThis2 = await client._sendMayFail("Runtime.evaluate", {
          expression: "globalThis",
          serializationOptions: { serialization: "idOnly" }
        });
        if (!globalThis2) {
          return;
        }
        var globalThisObjId = globalThis2["result"]["objectId"];
        var executionContextId = parseInt(globalThisObjId.split(".")[1], 10);
        var crContext = new import_crExecutionContext.CRExecutionContext(client, { id: executionContextId }, this._id);
        this._mainWorld = new import_dom.FrameExecutionContext(crContext, this, world);
        this._page._delegate._mainFrameSession._onExecutionContextCreated({
          id: executionContextId,
          origin: world,
          name: world,
          auxData: { isDefault: this === this._page.mainFrame(), type: "isolated", frameId: this._id }
        });
      }
    }
    if (world != "main" && this._isolatedWorld == void 0) {
      world = "utility";
      var result = await client._sendMayFail("Page.createIsolatedWorld", {
        frameId: this._id,
        grantUniveralAccess: true,
        worldName: world
      });
      if (!result) {
        return;
      }
      var executionContextId = result.executionContextId;
      var crContext = new import_crExecutionContext.CRExecutionContext(client, { id: executionContextId }, this._id);
      this._isolatedWorld = new import_dom.FrameExecutionContext(crContext, this, world);
      this._page._delegate._mainFrameSession._onExecutionContextCreated({
        id: executionContextId,
        origin: world,
        name: world,
        auxData: { isDefault: this === this._page.mainFrame(), type: "isolated", frameId: this._id }
      });
    }
    if (world != "main") {
      return this._isolatedWorld;
    } else if (this != this._page.mainFrame() && iframeExecutionContextId) {
      return this._iframeWorld;
    } else {
      return this._mainWorld;
    }
  }
  _mainContext() {
    return this._context("main");
  }
  _existingMainContext() {
    return this._contextData.get("main")?.context || null;
  }
  _utilityContext() {
    return this._context("utility");
  }
  async evaluateExpression(expression, options = {}, arg) {
    const context = await this._context(options.world ?? "main");
    const value = await context.evaluateExpression(expression, options, arg);
    return value;
  }
  async evaluateExpressionHandle(expression, options = {}, arg) {
    const context = await this._context(options.world ?? "main");
    const value = await context.evaluateExpressionHandle(expression, options, arg);
    return value;
  }
  async querySelector(selector, options) {
    import_debugLogger.debugLogger.log("api", `    finding element using the selector "${selector}"`);
    return this.selectors.query(selector, options);
  }
  async waitForSelector(metadata, selector, options, scope) {
    const controller = new import_progress.ProgressController(metadata, this);
    if (options.visibility)
      throw new Error("options.visibility is not supported, did you mean options.state?");
    if (options.waitFor && options.waitFor !== "visible")
      throw new Error("options.waitFor is not supported, did you mean options.state?");
    const { state = "visible" } = options;
    if (!["attached", "detached", "visible", "hidden"].includes(state))
      throw new Error(`state: expected one of (attached|detached|visible|hidden)`);
    return controller.run(async (progress) => {
      progress.log(`waiting for ${this._asLocator(selector)}${state === "attached" ? "" : " to be " + state}`);
      return await this.waitForSelectorInternal(progress, selector, true, options, scope);
    }, this._page._timeoutSettings.timeout(options));
  }
  async waitForSelectorInternal(progress, selector, performActionPreChecks, options, scope) {
    const {
      state = "visible"
    } = options;
    const promise = this._retryWithProgressIfNotConnected(progress, selector, options.strict, true, async (handle) => {
      const attached = !!handle;
      var visible = false;
      if (attached) {
        if (handle.parentNode.constructor.name == "ElementHandle") {
          visible = await handle.parentNode.evaluateInUtility(([injected, node, { handle: handle2 }]) => {
            return handle2 ? injected.utils.isElementVisible(handle2) : false;
          }, {
            handle
          });
        } else {
          visible = await handle.parentNode.evaluate((injected, { handle: handle2 }) => {
            return handle2 ? injected.utils.isElementVisible(handle2) : false;
          }, {
            handle
          });
        }
      }
      const success = {
        attached,
        detached: !attached,
        visible,
        hidden: !visible
      }[state];
      if (!success) {
        return "internal:continuepolling";
      }
      if (options.omitReturnValue) {
        return null;
      }
      const element = state === "attached" || state === "visible" ? handle : null;
      if (!element) return null;
      if (options.__testHookBeforeAdoptNode) await options.__testHookBeforeAdoptNode();
      try {
        return element;
      } catch (e) {
        return "internal:continuepolling";
      }
    }, "returnOnNotResolved");
    return scope ? scope._context._raceAgainstContextDestroyed(promise) : promise;
  }
  async dispatchEvent(metadata, selector, type, eventInit = {}, options = {}, scope) {
    await this._callOnElementOnceMatches(metadata, selector, (injectedScript, element, data) => {
      injectedScript.dispatchEvent(element, data.type, data.eventInit);
    }, { type, eventInit }, { mainWorld: true, ...options }, scope);
  }
  async evalOnSelector(selector, strict, expression, isFunction, arg, scope) {
    const handle = await this.selectors.query(selector, { strict }, scope);
    if (!handle)
      throw new Error(`Failed to find element matching selector "${selector}"`);
    const result = await handle.evaluateExpression(expression, { isFunction }, arg);
    handle.dispose();
    return result;
  }
  async evalOnSelectorAll(selector, expression, isFunction, arg, scope) {
    const arrayHandle = await this.selectors.queryArrayInMainWorld(selector, scope);
    const result = await arrayHandle.evaluateExpression(expression, { isFunction }, arg);
    arrayHandle.dispose();
    return result;
  }
  async maskSelectors(selectors, color) {
    const context = await this._utilityContext();
    const injectedScript = await context.injectedScript();
    await injectedScript.evaluate((injected, { parsed, color: color2 }) => {
      injected.maskSelectors(parsed, color2);
    }, { parsed: selectors, color });
  }
  async querySelectorAll(selector) {
    return this.selectors.queryAll(selector);
  }
  async queryCount(selector) {
    const custom_metadata = {
      "internal": false,
      "log": []
    };
    const controller = new import_progress.ProgressController(custom_metadata, this);
    const resultPromise = await controller.run(async (progress) => {
      progress.log("waiting for " + this._asLocator(selector));
      const promise = await this._retryWithProgressIfNotConnected(progress, selector, false, false, async (result) => {
        if (!result) return 0;
        const handle = result[0];
        const handles = result[1];
        return handle ? handles.length : 0;
      }, "returnAll");
      return promise;
    }, 1e4);
    return resultPromise ? resultPromise : 0;
  }
  async content() {
    try {
      const context = await this._utilityContext();
      return await context.evaluate(() => {
        let retVal = "";
        if (document.doctype)
          retVal = new XMLSerializer().serializeToString(document.doctype);
        if (document.documentElement)
          retVal += document.documentElement.outerHTML;
        return retVal;
      });
    } catch (e) {
      if (js.isJavaScriptErrorInEvaluate(e) || (0, import_protocolError.isSessionClosedError)(e))
        throw e;
      throw new Error(`Unable to retrieve content because the page is navigating and changing the content.`);
    }
  }
  async setContent(metadata, html, options = {}) {
    const controller = new import_progress.ProgressController(metadata, this);
    return controller.run(async (progress) => {
      await this.raceNavigationAction(progress, options, async () => {
        const waitUntil = options.waitUntil === void 0 ? "load" : options.waitUntil;
        progress.log(`setting frame content, waiting until "${waitUntil}"`);
        const tag = `--playwright--set--content--${this._id}--${++this._setContentCounter}--`;
        const bindingName = "_tagDebug" + import_crypto.default.randomBytes(20).toString("hex");
        const context = await this._utilityContext();
        await this._page._delegate._mainFrameSession._client.send("Runtime.addBinding", { name: bindingName });
        const lifecyclePromise = new Promise(async (resolve, reject) => {
          await this._page.exposeBinding(bindingName, false, (tag2) => {
            this._onClearLifecycle();
            this._waitForLoadState(progress, waitUntil).then(resolve).catch(reject);
          });
        });
        const contentPromise = context.evaluate(({ html: html2, tag: tag2, bindingName: bindingName2 }) => {
          document.open();
          var _tagDebug = window[bindingName2].bind({});
          delete window[bindingName2];
          _tagDebug('{ "name": "' + bindingName2 + '", "seq": 1, "serializedArgs": ["' + tag2 + '"] }');
          console.debug(tag2);
          document.write(html2);
          document.close();
        }, {
          html,
          tag,
          bindingName
        });
        await Promise.all([contentPromise, lifecyclePromise]);
        return null;
      });
    }, this._page._timeoutSettings.navigationTimeout(options));
  }
  name() {
    return this._name || "";
  }
  url() {
    return this._url;
  }
  origin() {
    if (!this._url.startsWith("http"))
      return;
    return network.parseURL(this._url)?.origin;
  }
  parentFrame() {
    return this._parentFrame;
  }
  childFrames() {
    return Array.from(this._childFrames);
  }
  async addScriptTag(params) {
    const {
      url = null,
      content = null,
      type = ""
    } = params;
    if (!url && !content)
      throw new Error("Provide an object with a `url`, `path` or `content` property");
    const context = await this._mainContext();
    return this._raceWithCSPError(async () => {
      if (url !== null)
        return (await context.evaluateHandle(addScriptUrl, { url, type })).asElement();
      const result = (await context.evaluateHandle(addScriptContent, { content, type })).asElement();
      if (this._page._delegate.cspErrorsAsynchronousForInlineScripts)
        await context.evaluate(() => true);
      return result;
    });
    async function addScriptUrl(params2) {
      const script = document.createElement("script");
      script.src = params2.url;
      if (params2.type)
        script.type = params2.type;
      const promise = new Promise((res, rej) => {
        script.onload = res;
        script.onerror = (e) => rej(typeof e === "string" ? new Error(e) : new Error(`Failed to load script at ${script.src}`));
      });
      document.head.appendChild(script);
      await promise;
      return script;
    }
    function addScriptContent(params2) {
      const script = document.createElement("script");
      script.type = params2.type || "text/javascript";
      script.text = params2.content;
      let error = null;
      script.onerror = (e) => error = e;
      document.head.appendChild(script);
      if (error)
        throw error;
      return script;
    }
  }
  async addStyleTag(params) {
    const {
      url = null,
      content = null
    } = params;
    if (!url && !content)
      throw new Error("Provide an object with a `url`, `path` or `content` property");
    const context = await this._mainContext();
    return this._raceWithCSPError(async () => {
      if (url !== null)
        return (await context.evaluateHandle(addStyleUrl, url)).asElement();
      return (await context.evaluateHandle(addStyleContent, content)).asElement();
    });
    async function addStyleUrl(url2) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = url2;
      const promise = new Promise((res, rej) => {
        link.onload = res;
        link.onerror = rej;
      });
      document.head.appendChild(link);
      await promise;
      return link;
    }
    async function addStyleContent(content2) {
      const style = document.createElement("style");
      style.type = "text/css";
      style.appendChild(document.createTextNode(content2));
      const promise = new Promise((res, rej) => {
        style.onload = res;
        style.onerror = rej;
      });
      document.head.appendChild(style);
      await promise;
      return style;
    }
  }
  async _raceWithCSPError(func) {
    const listeners = [];
    let result;
    let error;
    let cspMessage;
    const actionPromise = func().then((r) => result = r).catch((e) => error = e);
    const errorPromise = new Promise((resolve) => {
      listeners.push(import_eventsHelper.eventsHelper.addEventListener(this._page._browserContext, import_browserContext.BrowserContext.Events.Console, (message) => {
        if (message.page() !== this._page || message.type() !== "error")
          return;
        if (message.text().includes("Content-Security-Policy") || message.text().includes("Content Security Policy")) {
          cspMessage = message;
          resolve();
        }
      }));
    });
    await Promise.race([actionPromise, errorPromise]);
    import_eventsHelper.eventsHelper.removeEventListeners(listeners);
    if (cspMessage)
      throw new Error(cspMessage.text());
    if (error)
      throw error;
    return result;
  }
  async retryWithProgressAndTimeouts(progress, timeouts, action) {
    const continuePolling3 = Symbol("continuePolling");
    timeouts = [0, ...timeouts];
    let timeoutIndex = 0;
    while (progress.isRunning()) {
      const timeout = timeouts[Math.min(timeoutIndex++, timeouts.length - 1)];
      if (timeout) {
        const actionPromise = new Promise((f) => setTimeout(f, timeout));
        await import_utils.LongStandingScope.raceMultiple([
          this._page.openScope,
          this._detachedScope
        ], actionPromise);
      }
      progress.throwIfAborted();
      try {
        const result = await action(continuePolling3);
        if (result === continuePolling3)
          continue;
        return result;
      } catch (e) {
        if (this._isErrorThatCannotBeRetried(e))
          throw e;
        continue;
      }
    }
    progress.throwIfAborted();
    return void 0;
  }
  _isErrorThatCannotBeRetried(e) {
    if (js.isJavaScriptErrorInEvaluate(e) || (0, import_protocolError.isSessionClosedError)(e))
      return true;
    if (dom.isNonRecoverableDOMError(e) || (0, import_selectorParser.isInvalidSelectorError)(e))
      return true;
    if (this.isDetached())
      return true;
    return false;
  }
  async _retryWithProgressIfNotConnected(progress, selector, strict, performActionPreChecks, action, returnAction) {
    progress.log("waiting for " + this._asLocator(selector));
    return this.retryWithProgressAndTimeouts(progress, [0, 20, 50, 100, 100, 500], async (continuePolling3) => {
      if (performActionPreChecks) await this._page.performActionPreChecks(progress);
      const resolved = await this.selectors.resolveInjectedForSelector(selector, {
        strict
      });
      progress.throwIfAborted();
      if (!resolved) {
        if (returnAction === "returnOnNotResolved" || returnAction === "returnAll") {
          const result2 = await action(null);
          return result2 === "internal:continuepolling" ? continuePolling2 : result2;
        }
        return continuePolling3;
      }
      try {
        var client = this._page._delegate._sessionForFrame(resolved.frame)._client;
      } catch (e) {
        var client = this._page._delegate._mainFrameSession._client;
      }
      var context = await resolved.frame._context("main");
      const documentNode = await client.send("Runtime.evaluate", {
        expression: "document",
        serializationOptions: {
          serialization: "idOnly"
        },
        contextId: context.delegate._contextId
      });
      const documentScope = new dom.ElementHandle(context, documentNode.result.objectId);
      const currentScopingElements = await this._customFindElementsByParsed(resolved, client, context, documentScope, progress, resolved.info.parsed);
      if (currentScopingElements.length == 0) {
        if (returnAction === "returnOnNotResolved" || returnAction === "returnAll") {
          const result2 = await action(null);
          return result2 === "internal:continuepolling" ? continuePolling2 : result2;
        }
        return continuePolling3;
      }
      const resultElement = currentScopingElements[0];
      if (currentScopingElements.length > 1) {
        if (resolved.info.strict) {
          await resolved.injected.evaluateHandle((injected, {
            info,
            elements
          }) => {
            throw injected.strictModeViolationError(info.parsed, elements);
          }, {
            info: resolved.info,
            elements: currentScopingElements
          });
        }
        progress.log("  locator resolved to " + currentScopingElements.length + " elements. Proceeding with the first one: " + resultElement.preview());
      } else if (resultElement) {
        progress.log("  locator resolved to " + resultElement.preview());
      }
      try {
        var result = null;
        if (returnAction === "returnAll") {
          result = await action([resultElement, currentScopingElements]);
        } else {
          result = await action(resultElement);
        }
        if (result === "error:notconnected") {
          progress.log("element was detached from the DOM, retrying");
          return continuePolling3;
        } else if (result === "internal:continuepolling") {
          return continuePolling3;
        }
        return result;
      } finally {
      }
    });
  }
  async rafrafTimeoutScreenshotElementWithProgress(progress, selector, timeout, options) {
    return await this._retryWithProgressIfNotConnected(progress, selector, true, true, async (handle) => {
      await handle._frame.rafrafTimeout(timeout);
      return await this._page._screenshotter.screenshotElement(progress, handle, options);
    });
  }
  async click(metadata, selector, options) {
    const controller = new import_progress.ProgressController(metadata, this);
    return controller.run(async (progress) => {
      return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, !options.force, (handle) => handle._click(progress, { ...options, waitAfter: !options.noWaitAfter })));
    }, this._page._timeoutSettings.timeout(options));
  }
  async dblclick(metadata, selector, options = {}) {
    const controller = new import_progress.ProgressController(metadata, this);
    return controller.run(async (progress) => {
      return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, !options.force, (handle) => handle._dblclick(progress, options)));
    }, this._page._timeoutSettings.timeout(options));
  }
  async dragAndDrop(metadata, source, target, options = {}) {
    const controller = new import_progress.ProgressController(metadata, this);
    await controller.run(async (progress) => {
      dom.assertDone(await this._retryWithProgressIfNotConnected(progress, source, options.strict, !options.force, async (handle) => {
        return handle._retryPointerAction(progress, "move and down", false, async (point) => {
          await this._page.mouse.move(point.x, point.y);
          await this._page.mouse.down();
        }, {
          ...options,
          waitAfter: "disabled",
          position: options.sourcePosition,
          timeout: progress.timeUntilDeadline()
        });
      }));
      dom.assertDone(await this._retryWithProgressIfNotConnected(progress, target, options.strict, false, async (handle) => {
        return handle._retryPointerAction(progress, "move and up", false, async (point) => {
          await this._page.mouse.move(point.x, point.y);
          await this._page.mouse.up();
        }, {
          ...options,
          waitAfter: "disabled",
          position: options.targetPosition,
          timeout: progress.timeUntilDeadline()
        });
      }));
    }, this._page._timeoutSettings.timeout(options));
  }
  async tap(metadata, selector, options) {
    if (!this._page._browserContext._options.hasTouch)
      throw new Error("The page does not support tap. Use hasTouch context option to enable touch support.");
    const controller = new import_progress.ProgressController(metadata, this);
    return controller.run(async (progress) => {
      return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, !options.force, (handle) => handle._tap(progress, options)));
    }, this._page._timeoutSettings.timeout(options));
  }
  async fill(metadata, selector, value, options) {
    const controller = new import_progress.ProgressController(metadata, this);
    return controller.run(async (progress) => {
      return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, !options.force, (handle) => handle._fill(progress, value, options)));
    }, this._page._timeoutSettings.timeout(options));
  }
  async focus(metadata, selector, options = {}) {
    const controller = new import_progress.ProgressController(metadata, this);
    await controller.run(async (progress) => {
      dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, true, (handle) => handle._focus(progress)));
    }, this._page._timeoutSettings.timeout(options));
  }
  async blur(metadata, selector, options = {}) {
    const controller = new import_progress.ProgressController(metadata, this);
    await controller.run(async (progress) => {
      dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, true, (handle) => handle._blur(progress)));
    }, this._page._timeoutSettings.timeout(options));
  }
  async textContent(metadata, selector, options = {}, scope) {
    return this._callOnElementOnceMatches(metadata, selector, (injected, element) => element.textContent, void 0, options, scope);
  }
  async innerText(metadata, selector, options = {}, scope) {
    return this._callOnElementOnceMatches(metadata, selector, (injectedScript, element) => {
      if (element.namespaceURI !== "http://www.w3.org/1999/xhtml")
        throw injectedScript.createStacklessError("Node is not an HTMLElement");
      return element.innerText;
    }, void 0, options, scope);
  }
  async innerHTML(metadata, selector, options = {}, scope) {
    return this._callOnElementOnceMatches(metadata, selector, (injected, element) => element.innerHTML, void 0, options, scope);
  }
  async getAttribute(metadata, selector, name, options = {}, scope) {
    return this._callOnElementOnceMatches(metadata, selector, (injected, element, data) => element.getAttribute(data.name), { name }, options, scope);
  }
  async inputValue(metadata, selector, options = {}, scope) {
    return this._callOnElementOnceMatches(metadata, selector, (injectedScript, node) => {
      const element = injectedScript.retarget(node, "follow-label");
      if (!element || element.nodeName !== "INPUT" && element.nodeName !== "TEXTAREA" && element.nodeName !== "SELECT")
        throw injectedScript.createStacklessError("Node is not an <input>, <textarea> or <select> element");
      return element.value;
    }, void 0, options, scope);
  }
  async highlight(selector) {
    const resolved = await this.selectors.resolveInjectedForSelector(selector);
    if (!resolved)
      return;
    return await resolved.injected.evaluate((injected, { info }) => {
      return injected.highlight(info.parsed);
    }, { info: resolved.info });
  }
  async hideHighlight() {
    return this.raceAgainstEvaluationStallingEvents(async () => {
      const context = await this._utilityContext();
      const injectedScript = await context.injectedScript();
      return await injectedScript.evaluate((injected) => {
        return injected.hideHighlight();
      });
    });
  }
  async _elementState(metadata, selector, state, options = {}, scope) {
    const result = await this._callOnElementOnceMatches(metadata, selector, (injected, element, data) => {
      return injected.elementState(element, data.state);
    }, { state }, options, scope);
    if (result.received === "error:notconnected")
      dom.throwElementIsNotAttached();
    return result.matches;
  }
  async isVisible(metadata, selector, options = {}, scope) {
    const controller = new import_progress.ProgressController(metadata, this);
    return controller.run(async (progress) => {
      progress.log(`  checking visibility of ${this._asLocator(selector)}`);
      return await this.isVisibleInternal(selector, options, scope);
    }, this._page._timeoutSettings.timeout({}));
  }
  async isVisibleInternal(selector, options = {}, scope) {
    try {
      const custom_metadata = { "internal": false, "log": [] };
      const controller = new import_progress.ProgressController(custom_metadata, this);
      return await controller.run(async (progress) => {
        progress.log("waiting for " + this._asLocator(selector));
        const promise = this._retryWithProgressIfNotConnected(progress, selector, options.strict, false, async (handle) => {
          if (!handle) return false;
          if (handle.parentNode.constructor.name == "ElementHandle") {
            return await handle.parentNode.evaluateInUtility(([injected, node, { handle: handle2 }]) => {
              const state = handle2 ? injected.elementState(handle2, "visible") : {
                matches: false,
                received: "error:notconnected"
              };
              return state.matches;
            }, { handle });
          } else {
            return await handle.parentNode.evaluate((injected, { handle: handle2 }) => {
              const state = handle2 ? injected.elementState(handle2, "visible") : {
                matches: false,
                received: "error:notconnected"
              };
              return state.matches;
            }, { handle });
          }
        }, "returnOnNotResolved");
        return scope ? scope._context._raceAgainstContextDestroyed(promise) : promise;
      }, 1e4) || false;
    } catch (e) {
      if (js.isJavaScriptErrorInEvaluate(e) || (0, import_selectorParser.isInvalidSelectorError)(e) || (0, import_protocolError.isSessionClosedError)(e)) throw e;
      return false;
    }
  }
  async isHidden(metadata, selector, options = {}, scope) {
    return !await this.isVisible(metadata, selector, options, scope);
  }
  async isDisabled(metadata, selector, options = {}, scope) {
    return this._elementState(metadata, selector, "disabled", options, scope);
  }
  async isEnabled(metadata, selector, options = {}, scope) {
    return this._elementState(metadata, selector, "enabled", options, scope);
  }
  async isEditable(metadata, selector, options = {}, scope) {
    return this._elementState(metadata, selector, "editable", options, scope);
  }
  async isChecked(metadata, selector, options = {}, scope) {
    return this._elementState(metadata, selector, "checked", options, scope);
  }
  async hover(metadata, selector, options = {}) {
    const controller = new import_progress.ProgressController(metadata, this);
    return controller.run(async (progress) => {
      return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, !options.force, (handle) => handle._hover(progress, options)));
    }, this._page._timeoutSettings.timeout(options));
  }
  async selectOption(metadata, selector, elements, values, options = {}) {
    const controller = new import_progress.ProgressController(metadata, this);
    return controller.run(async (progress) => {
      return await this._retryWithProgressIfNotConnected(progress, selector, options.strict, !options.force, (handle) => handle._selectOption(progress, elements, values, options));
    }, this._page._timeoutSettings.timeout(options));
  }
  async setInputFiles(metadata, selector, params) {
    const inputFileItems = await (0, import_fileUploadUtils.prepareFilesForUpload)(this, params);
    const controller = new import_progress.ProgressController(metadata, this);
    return controller.run(async (progress) => {
      return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, params.strict, true, (handle) => handle._setInputFiles(progress, inputFileItems)));
    }, this._page._timeoutSettings.timeout(params));
  }
  async type(metadata, selector, text, options = {}) {
    const controller = new import_progress.ProgressController(metadata, this);
    return controller.run(async (progress) => {
      return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, true, (handle) => handle._type(progress, text, options)));
    }, this._page._timeoutSettings.timeout(options));
  }
  async press(metadata, selector, key, options = {}) {
    const controller = new import_progress.ProgressController(metadata, this);
    return controller.run(async (progress) => {
      return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, true, (handle) => handle._press(progress, key, options)));
    }, this._page._timeoutSettings.timeout(options));
  }
  async check(metadata, selector, options = {}) {
    const controller = new import_progress.ProgressController(metadata, this);
    return controller.run(async (progress) => {
      return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, !options.force, (handle) => handle._setChecked(progress, true, options)));
    }, this._page._timeoutSettings.timeout(options));
  }
  async uncheck(metadata, selector, options = {}) {
    const controller = new import_progress.ProgressController(metadata, this);
    return controller.run(async (progress) => {
      return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options.strict, !options.force, (handle) => handle._setChecked(progress, false, options)));
    }, this._page._timeoutSettings.timeout(options));
  }
  async waitForTimeout(metadata, timeout) {
    const controller = new import_progress.ProgressController(metadata, this);
    return controller.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, timeout));
    });
  }
  async ariaSnapshot(metadata, selector, options = {}) {
    const controller = new import_progress.ProgressController(metadata, this);
    return controller.run(async (progress) => {
      return await this._retryWithProgressIfNotConnected(progress, selector, true, true, (handle) => handle.ariaSnapshot(options));
    }, this._page._timeoutSettings.timeout(options));
  }
  async expect(metadata, selector, options) {
    const result = await this._expectImpl(metadata, selector, options);
    if (result.matches === options.isNot)
      metadata.error = { error: { name: "Expect", message: "Expect failed" } };
    return result;
  }
  async _expectImpl(metadata, selector, options) {
    const lastIntermediateResult = { isSet: false };
    try {
      let timeout = this._page._timeoutSettings.timeout(options);
      const start = timeout > 0 ? (0, import_utils.monotonicTime)() : 0;
      await new import_progress.ProgressController(metadata, this).run(async (progress) => {
        progress.log(`${metadata.apiName}${timeout ? ` with timeout ${timeout}ms` : ""}`);
        progress.log(`waiting for ${this._asLocator(selector)}`);
        await this._page.performActionPreChecks(progress);
      }, timeout);
      try {
        const resultOneShot = await new import_progress.ProgressController(metadata, this).run(async (progress) => {
          return await this._expectInternal(progress, selector, options, lastIntermediateResult);
        });
        if (resultOneShot.matches !== options.isNot)
          return resultOneShot;
      } catch (e) {
        if (js.isJavaScriptErrorInEvaluate(e) || (0, import_selectorParser.isInvalidSelectorError)(e))
          throw e;
      }
      if (timeout > 0) {
        const elapsed = (0, import_utils.monotonicTime)() - start;
        timeout -= elapsed;
      }
      if (timeout < 0)
        return { matches: options.isNot, log: (0, import_callLog.compressCallLog)(metadata.log), timedOut: true, received: lastIntermediateResult.received };
      return await new import_progress.ProgressController(metadata, this).run(async (progress) => {
        return await this.retryWithProgressAndTimeouts(progress, [100, 250, 500, 1e3], async (continuePolling3) => {
          await this._page.performActionPreChecks(progress);
          const { matches, received } = await this._expectInternal(progress, selector, options, lastIntermediateResult);
          if (matches === options.isNot) {
            return continuePolling3;
          }
          return { matches, received };
        });
      }, timeout);
    } catch (e) {
      if (js.isJavaScriptErrorInEvaluate(e) || (0, import_selectorParser.isInvalidSelectorError)(e))
        throw e;
      const result = { matches: options.isNot, log: (0, import_callLog.compressCallLog)(metadata.log) };
      if (lastIntermediateResult.isSet)
        result.received = lastIntermediateResult.received;
      if (e instanceof import_errors.TimeoutError)
        result.timedOut = true;
      return result;
    }
  }
  async _expectInternal(progress, selector, options, lastIntermediateResult) {
    progress.log("waiting for " + this._asLocator(selector));
    const isArray = options.expression === "to.have.count" || options.expression.endsWith(".array");
    const promise = await this._retryWithProgressIfNotConnected(progress, selector, !isArray, false, async (result) => {
      const handle = result[0];
      const handles = result[1];
      if (handle.parentNode.constructor.name == "ElementHandle") {
        return await handle.parentNode.evaluateInUtility(async ([injected, node, { handle: handle2, options: options2, handles: handles2 }]) => {
          return await injected.expect(handle2, options2, handles2);
        }, { handle, options, handles });
      } else {
        return await handle.parentNode.evaluate(async (injected, { handle: handle2, options: options2, handles: handles2 }) => {
          return await injected.expect(handle2, options2, handles2);
        }, { handle, options, handles });
      }
    }, "returnAll");
    var matches = false;
    var received = 0;
    var missingReceived = null;
    if (promise) {
      matches = promise.matches;
      received = promise.received;
      missingReceived = promise.missingReceived;
    } else if (options.expectedNumber === 0) {
      matches = true;
    }
    if (matches === options.isNot) {
      lastIntermediateResult.received = missingReceived ? "<element(s) not found>" : received;
      lastIntermediateResult.isSet = true;
      if (!missingReceived && !Array.isArray(received)) progress.log('  unexpected value "' + renderUnexpectedValue(options.expression, received) + '"');
    }
    return {
      matches,
      received
    };
  }
  async _waitForFunctionExpression(metadata, expression, isFunction, arg, options, world = "main") {
    const controller = new import_progress.ProgressController(metadata, this);
    if (typeof options.pollingInterval === "number")
      (0, import_utils.assert)(options.pollingInterval > 0, "Cannot poll with non-positive interval: " + options.pollingInterval);
    expression = js.normalizeEvaluationExpression(expression, isFunction);
    return controller.run(async (progress) => {
      return this.retryWithProgressAndTimeouts(progress, [100], async () => {
        const context = world === "main" ? await this._mainContext() : await this._utilityContext();
        const injectedScript = await context.injectedScript();
        const handle = await injectedScript.evaluateHandle((injected, { expression: expression2, isFunction: isFunction2, polling, arg: arg2 }) => {
          const predicate = () => {
            let result2 = globalThis.eval(expression2);
            if (isFunction2 === true) {
              result2 = result2(arg2);
            } else if (isFunction2 === false) {
              result2 = result2;
            } else {
              if (typeof result2 === "function")
                result2 = result2(arg2);
            }
            return result2;
          };
          let fulfill;
          let reject;
          let aborted = false;
          const result = new Promise((f, r) => {
            fulfill = f;
            reject = r;
          });
          const next = () => {
            if (aborted)
              return;
            try {
              const success = predicate();
              if (success) {
                fulfill(success);
                return;
              }
              if (typeof polling !== "number")
                injected.utils.builtins.requestAnimationFrame(next);
              else
                injected.utils.builtins.setTimeout(next, polling);
            } catch (e) {
              reject(e);
            }
          };
          next();
          return { result, abort: () => aborted = true };
        }, { expression, isFunction, polling: options.pollingInterval, arg });
        progress.cleanupWhenAborted(() => handle.evaluate((h) => h.abort()).catch(() => {
        }));
        return handle.evaluateHandle((h) => h.result);
      });
    }, this._page._timeoutSettings.timeout(options));
  }
  async waitForFunctionValueInUtility(progress, pageFunction) {
    const expression = `() => {
      const result = (${pageFunction})();
      if (!result)
        return result;
      return JSON.stringify(result);
    }`;
    const handle = await this._waitForFunctionExpression((0, import_instrumentation.serverSideCallMetadata)(), expression, true, void 0, { timeout: progress.timeUntilDeadline() }, "utility");
    return JSON.parse(handle.rawValue());
  }
  async title() {
    const context = await this._utilityContext();
    return context.evaluate(() => document.title);
  }
  async rafrafTimeout(timeout) {
    if (timeout === 0)
      return;
    const context = await this._utilityContext();
    await Promise.all([
      // wait for double raf
      context.evaluate(() => new Promise((x) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(x);
        });
      })),
      new Promise((fulfill) => setTimeout(fulfill, timeout))
    ]);
  }
  _onDetached() {
    this._stopNetworkIdleTimer();
    this._detachedScope.close(new Error("Frame was detached"));
    for (const data of this._contextData.values()) {
      if (data.context)
        data.context.contextDestroyed("Frame was detached");
      data.contextPromise.resolve({ destroyedReason: "Frame was detached" });
    }
    if (this._parentFrame)
      this._parentFrame._childFrames.delete(this);
    this._parentFrame = null;
  }
  async _callOnElementOnceMatches(metadata, selector, body, taskData, options = {}, scope) {
    const callbackText = body.toString();
    const controller = new import_progress.ProgressController(metadata, this);
    return controller.run(async (progress) => {
      progress.log("waiting for " + this._asLocator(selector));
      const promise = this._retryWithProgressIfNotConnected(progress, selector, false, false, async (handle) => {
        if (handle.parentNode.constructor.name == "ElementHandle") {
          return await handle.parentNode.evaluateInUtility(([injected, node, { callbackText: callbackText2, handle: handle2, taskData: taskData2 }]) => {
            const callback = injected.eval(callbackText2);
            return callback(injected, handle2, taskData2);
          }, {
            callbackText,
            handle,
            taskData
          });
        } else {
          return await handle.parentNode.evaluate((injected, { callbackText: callbackText2, handle: handle2, taskData: taskData2 }) => {
            const callback = injected.eval(callbackText2);
            return callback(injected, handle2, taskData2);
          }, {
            callbackText,
            handle,
            taskData
          });
        }
      });
      return scope ? scope._context._raceAgainstContextDestroyed(promise) : promise;
    }, this._page._timeoutSettings.timeout(options));
  }
  _setContext(world, context) {
    const data = this._contextData.get(world);
    data.context = context;
    if (context)
      data.contextPromise.resolve(context);
    else
      data.contextPromise = new import_manualPromise.ManualPromise();
  }
  _contextCreated(world, context) {
    const data = this._contextData.get(world);
    if (data.context) {
      data.context.contextDestroyed("Execution context was destroyed, most likely because of a navigation");
      this._setContext(world, null);
    }
    this._setContext(world, context);
  }
  _contextDestroyed(context) {
    if (this._detachedScope.isClosed())
      return;
    context.contextDestroyed("Execution context was destroyed, most likely because of a navigation");
    for (const [world, data] of this._contextData) {
      if (data.context === context)
        this._setContext(world, null);
    }
  }
  _startNetworkIdleTimer() {
    (0, import_utils.assert)(!this._networkIdleTimer);
    if (this._firedLifecycleEvents.has("networkidle") || this._detachedScope.isClosed())
      return;
    this._networkIdleTimer = setTimeout(() => {
      this._firedNetworkIdleSelf = true;
      this._page.mainFrame()._recalculateNetworkIdle();
    }, 500);
  }
  _stopNetworkIdleTimer() {
    if (this._networkIdleTimer)
      clearTimeout(this._networkIdleTimer);
    this._networkIdleTimer = void 0;
    this._firedNetworkIdleSelf = false;
  }
  async extendInjectedScript(source, arg) {
    const context = await this._context("main");
    const injectedScriptHandle = await context.injectedScript();
    return injectedScriptHandle.evaluateHandle((injectedScript, { source: source2, arg: arg2 }) => {
      return injectedScript.extend(source2, arg2);
    }, { source, arg });
  }
  async resetStorageForCurrentOriginBestEffort(newStorage) {
    const context = await this._utilityContext();
    await context.evaluate(async ({ ls }) => {
      sessionStorage.clear();
      localStorage.clear();
      for (const entry of ls || [])
        localStorage[entry.name] = entry.value;
      const registrations = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
      await Promise.all(registrations.map(async (r) => {
        if (!r.installing && !r.waiting && !r.active)
          r.unregister().catch(() => {
          });
        else
          await r.unregister().catch(() => {
          });
      }));
      for (const db of await indexedDB.databases?.() || []) {
        if (db.name)
          indexedDB.deleteDatabase(db.name);
      }
    }, { ls: newStorage?.localStorage }).catch(() => {
    });
  }
  _asLocator(selector) {
    return (0, import_utils.asLocator)(this._page.attribution.playwright.options.sdkLanguage, selector);
  }
  async _getFrameMainFrameContextId(client) {
    try {
      var globalDocument = await client._sendMayFail("DOM.getFrameOwner", { frameId: this._id });
      if (globalDocument && globalDocument.nodeId) {
        var describedNode = await client._sendMayFail("DOM.describeNode", {
          backendNodeId: globalDocument.backendNodeId
        });
        if (describedNode) {
          var resolvedNode = await client._sendMayFail("DOM.resolveNode", {
            nodeId: describedNode.node.contentDocument.nodeId
          });
          var _executionContextId = parseInt(resolvedNode.object.objectId.split(".")[1], 10);
          return _executionContextId;
        }
      }
    } catch (e) {
    }
    return 0;
  }
  async _customFindElementsByParsed(resolved, client, context, documentScope, progress, parsed) {
    var parsedEdits = { ...parsed };
    var currentScopingElements = [documentScope];
    while (parsed.parts.length > 0) {
      var part = parsed.parts.shift();
      parsedEdits.parts = [part];
      var elements = [];
      var elementsIndexes = [];
      if (part.name == "nth") {
        const partNth = Number(part.body);
        if (partNth > currentScopingElements.length || partNth < -currentScopingElements.length) {
          return continuePolling;
        } else {
          currentScopingElements = [currentScopingElements.at(partNth)];
          continue;
        }
      } else if (part.name == "internal:or") {
        var orredElements = await this._customFindElementsByParsed(resolved, client, context, documentScope, progress, part.body.parsed);
        elements = currentScopingElements.concat(orredElements);
      } else if (part.name == "internal:and") {
        var andedElements = await this._customFindElementsByParsed(resolved, client, context, documentScope, progress, part.body.parsed);
        const backendNodeIds = new Set(andedElements.map((item) => item.backendNodeId));
        elements = currentScopingElements.filter((item) => backendNodeIds.has(item.backendNodeId));
      } else {
        for (const scope of currentScopingElements) {
          let findClosedShadowRoots2 = function(node, results = []) {
            if (!node || typeof node !== "object") return results;
            if (node.shadowRoots && Array.isArray(node.shadowRoots)) {
              for (const shadowRoot2 of node.shadowRoots) {
                if (shadowRoot2.shadowRootType === "closed" && shadowRoot2.backendNodeId) {
                  results.push(shadowRoot2.backendNodeId);
                }
                findClosedShadowRoots2(shadowRoot2, results);
              }
            }
            if (node.nodeName !== "IFRAME" && node.children && Array.isArray(node.children)) {
              for (const child of node.children) {
                findClosedShadowRoots2(child, results);
              }
            }
            return results;
          };
          var findClosedShadowRoots = findClosedShadowRoots2;
          const describedScope = await client.send("DOM.describeNode", {
            objectId: scope._objectId,
            depth: -1,
            pierce: true
          });
          var queryingElements = [];
          var shadowRootBackendIds = findClosedShadowRoots2(describedScope.node);
          var shadowRoots = [];
          for (var shadowRootBackendId of shadowRootBackendIds) {
            var resolvedShadowRoot = await client.send("DOM.resolveNode", {
              backendNodeId: shadowRootBackendId,
              contextId: context.delegate._contextId
            });
            shadowRoots.push(new dom.ElementHandle(context, resolvedShadowRoot.object.objectId));
          }
          for (var shadowRoot of shadowRoots) {
            const shadowElements = await shadowRoot.evaluateHandleInUtility(([injected, node, { parsed: parsed2, callId }]) => {
              const elements2 = injected.querySelectorAll(parsed2, node);
              if (callId) injected.markTargetElements(new Set(elements2), callId);
              return elements2;
            }, {
              parsed: parsedEdits,
              callId: progress.metadata.id
            });
            const shadowElementsAmount = await shadowElements.getProperty("length");
            queryingElements.push([shadowElements, shadowElementsAmount, shadowRoot]);
          }
          const rootElements = await scope.evaluateHandleInUtility(([injected, node, { parsed: parsed2, callId }]) => {
            const elements2 = injected.querySelectorAll(parsed2, node);
            if (callId) injected.markTargetElements(new Set(elements2), callId);
            return elements2;
          }, {
            parsed: parsedEdits,
            callId: progress.metadata.id
          });
          const rootElementsAmount = await rootElements.getProperty("length");
          queryingElements.push([rootElements, rootElementsAmount, resolved.injected]);
          for (var queryedElement of queryingElements) {
            var elementsToCheck = queryedElement[0];
            var elementsAmount = await queryedElement[1].jsonValue();
            var parentNode = queryedElement[2];
            for (var i = 0; i < elementsAmount; i++) {
              if (parentNode.constructor.name == "ElementHandle") {
                var elementToCheck = await parentNode.evaluateHandleInUtility(([injected, node, { index, elementsToCheck: elementsToCheck2 }]) => {
                  return elementsToCheck2[index];
                }, { index: i, elementsToCheck });
              } else {
                var elementToCheck = await parentNode.evaluateHandle((injected, { index, elementsToCheck: elementsToCheck2 }) => {
                  return elementsToCheck2[index];
                }, { index: i, elementsToCheck });
              }
              elementToCheck.parentNode = parentNode;
              var resolvedElement = await client.send("DOM.describeNode", {
                objectId: elementToCheck._objectId,
                depth: -1
              });
              elementToCheck.backendNodeId = resolvedElement.node.backendNodeId;
              elements.push(elementToCheck);
            }
          }
        }
      }
      currentScopingElements = [];
      for (var element of elements) {
        var elemIndex = element.backendNodeId;
        var elemPos = elementsIndexes.findIndex((index) => index > elemIndex);
        if (elemPos === -1) {
          currentScopingElements.push(element);
          elementsIndexes.push(elemIndex);
        } else {
          currentScopingElements.splice(elemPos, 0, element);
          elementsIndexes.splice(elemPos, 0, elemIndex);
        }
      }
    }
    return currentScopingElements;
  }
}
class SignalBarrier {
  constructor(progress) {
    this._protectCount = 0;
    this._promise = new import_manualPromise.ManualPromise();
    this._progress = progress;
    this.retain();
  }
  waitFor() {
    this.release();
    return this._promise;
  }
  async addFrameNavigation(frame) {
    if (frame.parentFrame())
      return;
    this.retain();
    const waiter = import_helper.helper.waitForEvent(null, frame, Frame.Events.InternalNavigation, (e) => {
      if (!e.isPublic)
        return false;
      if (!e.error && this._progress)
        this._progress.log(`  navigated to "${frame._url}"`);
      return true;
    });
    await import_utils.LongStandingScope.raceMultiple([
      frame._page.openScope,
      frame._detachedScope
    ], waiter.promise).catch(() => {
    });
    waiter.dispose();
    this.release();
  }
  retain() {
    ++this._protectCount;
  }
  release() {
    --this._protectCount;
    if (!this._protectCount)
      this._promise.resolve();
  }
}
function verifyLifecycle(name, waitUntil) {
  if (waitUntil === "networkidle0")
    waitUntil = "networkidle";
  if (!types.kLifecycleEvents.has(waitUntil))
    throw new Error(`${name}: expected one of (load|domcontentloaded|networkidle|commit)`);
  return waitUntil;
}
function renderUnexpectedValue(expression, received) {
  if (expression === "to.match.aria")
    return received ? received.raw : received;
  return received;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Frame,
  FrameManager,
  NavigationAbortedError
});
