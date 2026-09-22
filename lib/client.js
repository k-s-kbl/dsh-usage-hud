window.__ModuleLoader__.load({
	id: "@local/dsh-usage-hud",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var ReactDOM = require("react-dom");

		var h = React.createElement;
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useMemo = React.useMemo;
		var useRef = React.useRef;
		var useCallback = React.useCallback;

		//#region stylesheet
		var css = ".dshUh_root{position:fixed;z-index:80;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);-webkit-user-select:none;user-select:none}.dshUh_pill,.dshUh_panel{box-sizing:border-box;background:var(--dsw-specific-menu);border:1px solid var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);border-radius:12px}.dshUh_pill{align-items:center;gap:10px;padding:6px 10px;display:flex;font-variant-numeric:tabular-nums;cursor:grab;touch-action:none;color:var(--dsw-alias-label-secondary);background:var(--dsw-specific-menu);border:1px solid var(--dsw-alias-border-l1)}.dshUh_pill:active{cursor:grabbing}.dshUh_pill:hover{color:var(--dsw-alias-label-primary)}.dshUh_pillItem{align-items:center;gap:4px;display:inline-flex;white-space:nowrap}.dshUh_pillValue{color:var(--dsw-alias-label-primary);font-weight:500}.dshUh_pillKey{color:var(--dsw-alias-label-tertiary)}.dshUh_panel{width:296px;display:flex;flex-direction:column;max-height:calc(100vh - 16px);overflow:hidden}.dshUh_head{display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:grab;touch-action:none;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}.dshUh_head:active{cursor:grabbing}.dshUh_title{font-weight:600;color:var(--dsw-alias-label-primary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dshUh_iconBtn{display:grid;place-items:center;width:22px;height:22px;flex:none;border:0;border-radius:6px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0}.dshUh_iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dshUh_body{padding:8px 10px 10px;display:flex;flex-direction:column;gap:10px;flex:1 1 auto;min-height:0;overflow:auto}.dshUh_section{display:flex;flex-direction:column;gap:4px}.dshUh_sectionHead{display:flex;align-items:baseline;gap:8px}.dshUh_sectionTitle{color:var(--dsw-alias-label-tertiary);flex:1;min-width:0}.dshUh_strong{color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums}.dshUh_row{display:flex;align-items:baseline;gap:8px;justify-content:space-between}.dshUh_row dt{color:var(--dsw-alias-label-tertiary)}.dshUh_row dd{margin:0;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}.dshUh_rows{margin:0;display:flex;flex-direction:column;gap:2px}.dshUh_hint{color:var(--dsw-alias-label-tertiary);word-break:break-word}.dshUh_warn{color:var(--dsw-alias-label-secondary)}.dshUh_bar{display:flex;gap:1px;height:5px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-interactive-bg-hover);margin:2px 0 1px}.dshUh_seg{height:100%;flex:none;min-width:2px;background:var(--dsh-meter-tint,var(--dsw-alias-label-tertiary))}.dshUh_system{--dsh-meter-tint:var(--dsw-static-neutral-bluish-400)}.dshUh_tools{--dsh-meter-tint:#a78bfa}.dshUh_messages{--dsh-meter-tint:var(--dsw-static-blue-450)}.dshUh_swatch{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:var(--dsh-meter-tint)}.dshUh_split{display:flex;flex-wrap:wrap;justify-content:space-between;gap:2px 12px}.dshUh_split>span{white-space:nowrap}.dshUh_divider{height:1px;background:var(--dsw-alias-border-l1);margin:0}.dshUh_good{color:var(--dsw-alias-label-primary)}";
		var tagId = "@local/dsh-usage-hud/usage-hud.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			var tag = document.createElement("style");
			tag.dataset.plugin = "@local/dsh-usage-hud";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region constants
		/** Locale namespace owned by this plugin. */
		var NS = "usage-hud";
		/** Host-provided balance route (see the host half). */
		var BALANCE_URL = "/api/usage-hud/balance";
		/** Host-provided price table and current billing regime. */
		var PRICING_URL = "/api/usage-hud/pricing";
		/** Idle poll floor; a spend-driven read usually lands well before this. */
		var BALANCE_INTERVAL_MS = 60000;
		/** Wait for a burst of usage samples to settle before reading the balance. */
		var BALANCE_SETTLE_MS = 3000;
		/** Never issue two upstream balance reads closer together than this. */
		var BALANCE_MIN_GAP_MS = 15000;
		/**
		 * Follow-up delay when a spend-driven read comes back unchanged. The
		 * provider settles its own balance on a roughly minute-long cadence, so a
		 * single read right after a turn often predates the charge; a few spaced
		 * retries converge on it instead of waiting out the idle poll.
		 */
		var BALANCE_RETRY_MS = 20000;
		/** Follow-up reads allowed per spend episode. */
		var BALANCE_RETRY_BUDGET = 3;
		/** Where the collapsed flag and the dragged position survive a reload. */
		var STORAGE_KEY = "dsh.usage-hud.v1";
		/** Document body portal host; a floating layer must not inherit composer layout. */
		var PORTAL = typeof ReactDOM !== "undefined" && ReactDOM !== null && typeof ReactDOM.createPortal === "function";
		//#endregion

		//#region helpers
		/** Round to one decimal, dropping a trailing .0. */
		function round1(value) {
			return Math.round(value * 10) / 10;
		}
		/** Compact token count: raw below 1k, then k, then M. */
		function formatTokens(value, t) {
			if (!Number.isFinite(value)) return "—";
			if (value < 1000) return String(Math.round(value));
			if (value < 1e6) return t("unit.thousand", { value: String(round1(value / 1e3)) });
			return t("unit.million", { value: String(round1(value / 1e6)) });
		}
		/** Currency amount with the right symbol for CNY and USD, code otherwise. */
		function formatMoney(amount, currency, t) {
			var value = String(amount);
			if (currency === "CNY") return t("money.cny", { amount: value });
			if (currency === "USD") return t("money.usd", { amount: value });
			return t("money.other", { amount: value, currency: String(currency) });
		}
		/**
		* Format a spend figure at a fixed four decimals. The precision is uniform
		* on purpose: the panel shows a total above its own parts, and a reader will
		* add them up, so switching to two decimals above ¥1 would make the rows
		* visibly fail to reconcile with the headline. A single step routinely costs
		* a fraction of a cent, so the extra places carry real information.
		*/
		function formatCost(value, t) {
			if (!Number.isFinite(value)) return "—";
			return t("money.cny", { amount: value.toFixed(4) });
		}
		/**
		* Price one whole-log token usage against one regime's rate set.
		* @param totals - the `tokenUsage` projection.
		* @param rateSet - the priced row for the session's model and regime.
		* @param unit - tokens the rates are quoted per (the host sends 1e6).
		* @returns per-bucket spend in currency, the total, and whether every rate was configured.
		*/
		function costOf(totals, rateSet, unit) {
			if (totals === undefined || rateSet === undefined || rateSet === null) return undefined;
			var per = typeof unit === "number" && unit > 0 ? unit : 1e6;
			var complete = ["inputCached", "inputUncached", "output", "inputCacheWrite"].every(function (key) {
				return typeof rateSet[key] === "number";
			});
			var parts = {
				cached: (rateSet.inputCached || 0) * totals.cacheReadTokens / per,
				uncached: (rateSet.inputUncached || 0) * totals.uncachedInputTokens / per,
				output: (rateSet.output || 0) * totals.outputTokens / per,
				cacheWrite: (rateSet.inputCacheWrite || 0) * totals.cacheWriteTokens / per
			};
			return {
				parts: parts,
				total: parts.cached + parts.uncached + parts.output + parts.cacheWrite,
				complete: complete
			};
		}
		/**
		* Owns *when* the next balance read happens, independently of *how* it is
		* performed, so the cadence policy is testable without a browser. The
		* policy exists because spending is what makes a balance stale: a rising
		* cost schedules a forced read once the burst settles, an unchanged answer
		* is retried a bounded number of times while the provider settles its own
		* books, and nothing ever reads upstream twice inside the minimum gap.
		* @param deps - `run(force)`, plus injectable `now`/timers for tests.
		* @returns the scheduler's trigger surface.
		*/
		function createBalanceScheduler(deps) {
			var timer;
			/** Undefined until the first read leaves, so "never read" needs no epoch baseline. */
			var lastReadAt;
			var retries = 0;
			/** Arm the single pending read, replacing any read already pending. */
			function schedule(force, delay) {
				if (timer !== undefined) deps.clearTimeout(timer);
				timer = deps.setTimeout(function () {
					timer = undefined;
					var wait = lastReadAt === undefined ? 0 : BALANCE_MIN_GAP_MS - (deps.now() - lastReadAt);
					if (wait > 0) {
						schedule(force, wait);
						return;
					}
					lastReadAt = deps.now();
					deps.run(force);
				}, delay);
			}
			return {
				/** Spend was observed: read once the burst settles, with retries armed. */
				onSpend: function () {
					retries = BALANCE_RETRY_BUDGET;
					schedule(true, BALANCE_SETTLE_MS);
				},
				/** Idle floor: a cached read is enough when nothing was spent. */
				onIdle: function () {
					schedule(false, 0);
				},
				/** Explicit user gesture: read now, bypassing the gap. */
				onManual: function () {
					if (timer !== undefined) {
						deps.clearTimeout(timer);
						timer = undefined;
					}
					lastReadAt = deps.now();
					retries = 0;
					deps.run(true);
				},
				/**
				* Account for one completed read.
				* @param changed - whether the total moved since the previous read.
				* @returns whether a follow-up read was scheduled.
				*/
				onSettled: function (changed) {
					if (changed || retries <= 0) {
						retries = 0;
						return false;
					}
					retries -= 1;
					schedule(true, BALANCE_RETRY_MS);
					return true;
				},
				/** Cancel any pending read. */
				dispose: function () {
					if (timer !== undefined) {
						deps.clearTimeout(timer);
						timer = undefined;
					}
				},
			};
		}

		/**
		* Resolve which priced model row applies to a session: its own billed
		* model when the table knows it, otherwise the host's declared default.
		* @param models - the host's model-id-to-regime table.
		* @param modelId - the model the session last issued a request with.
		* @param fallback - the host's default model id.
		* @returns the resolved id and whether it is the session's own.
		*/
		function pricedModelFor(models, modelId, fallback) {
			if (modelId !== undefined && models[modelId] !== undefined) return { id: modelId, exact: true };
			if (fallback !== undefined && models[fallback] !== undefined) return { id: fallback, exact: false };
			return undefined;
		}
		/** Two-unit elapsed time, mirroring the background-job list's vocabulary. */
		function formatDuration(ms, t) {
			var total = Math.max(0, Math.floor(ms / 1e3));
			var seconds = total % 60;
			var minutes = Math.floor(total / 60) % 60;
			var hours = Math.floor(total / 3600);
			if (hours > 0) return t("duration.hours", { hours: String(hours), minutes: String(minutes) });
			if (minutes > 0) return t("duration.minutes", { minutes: String(minutes), seconds: String(seconds) });
			return t("duration.seconds", { seconds: String(seconds) });
		}
		/**
		* Read the persisted collapsed flag and dragged position, falling back on any
		* corruption. `placed` records whether a position was ever stored: without
		* one the panel is anchored to the top-right on first mount rather than
		* using a guessed offset, so first placement never depends on the panel's
		* height (which is unknown until it has rendered once).
		*/
		function readPrefs() {
			var fallback = { collapsed: false, right: 16, bottom: 96, placed: false };
			try {
				var raw = globalThis.localStorage === undefined ? null : globalThis.localStorage.getItem(STORAGE_KEY);
				if (raw === null) return fallback;
				var parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object") return fallback;
				var hasPosition = (typeof parsed.right === "number" && Number.isFinite(parsed.right)) || (typeof parsed.bottom === "number" && Number.isFinite(parsed.bottom));
				return {
					collapsed: parsed.collapsed === true,
					right: typeof parsed.right === "number" && Number.isFinite(parsed.right) ? parsed.right : fallback.right,
					bottom: typeof parsed.bottom === "number" && Number.isFinite(parsed.bottom) ? parsed.bottom : fallback.bottom,
					placed: parsed.placed === true || hasPosition
				};
			} catch (error) {
				return fallback;
			}
		}
		/** Persist the collapsed flag and dragged position; storage failures are not user-visible. */
		function writePrefs(next) {
			try {
				if (globalThis.localStorage !== undefined) globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
			} catch (error) {}
		}
		/** Smallest gap kept between the panel and any viewport edge. */
		var EDGE = 8;
		/**
		* Pointer travel, in px, that turns a press on the collapsed pill into a
		* drag rather than a click. The pill is both the drag handle and the
		* expand control, so the two gestures are separated by distance.
		*/
		var DRAG_THRESHOLD = 4;
		/** The viewport the panel is positioned against. */
		function viewportSize() {
			return {
				width: typeof globalThis.innerWidth === "number" ? globalThis.innerWidth : 1280,
				height: typeof globalThis.innerHeight === "number" ? globalThis.innerHeight : 800
			};
		}
		/**
		* Constrain a fixed-position offset so the WHOLE box stays inside the
		* viewport. Clamping the offset alone is not enough: `bottom` is measured to
		* the box's bottom edge, so an offset that is "small" still pushes the top
		* edge off-screen once the box is taller than the remaining room — which is
		* how the panel became undraggable after being dragged upward.
		* @param offsets - desired `{ right, bottom }` in px.
		* @param size - the box's measured `{ width, height }`.
		* @param viewport - `{ width, height }`.
		* @returns offsets placing every edge at least {@link EDGE} from the border.
		*/
		function clampOffsets(offsets, size, viewport) {
			var maxRight = Math.max(EDGE, viewport.width - size.width - EDGE);
			var maxBottom = Math.max(EDGE, viewport.height - size.height - EDGE);
			return {
				right: Math.max(EDGE, Math.min(offsets.right, maxRight)),
				bottom: Math.max(EDGE, Math.min(offsets.bottom, maxBottom))
			};
		}
		/** Human provenance of the resolved credential, never the secret itself. */
		function keySourceLabel(payload, t) {
			var source = payload === undefined ? undefined : payload.keySource;
			if (source === "env") return t("balance.source.env");
			if (source === "file") return t("balance.source.file");
			if (source === "dotenv" || source === "project-dotenv" || source === "home-dotenv") return t("balance.source.dotenv");
			return source === undefined ? "" : t("balance.source.credentials");
		}
		//#endregion

		//#region icons
		function icon(path) {
			return h("svg", { viewBox: "0 0 16 16", width: "13", height: "13", "aria-hidden": true, fill: "currentColor" }, h("path", { d: path }));
		}
		/** Refresh arrow. */
		function IconRefresh() {
			return icon("M8 2.5a5.5 5.5 0 1 0 5.24 3.84.75.75 0 1 0-1.43.46A4 4 0 1 1 8 4h.02L6.9 5.12a.75.75 0 0 0 1.06 1.06l2.3-2.3a.75.75 0 0 0 0-1.06L7.96.52A.75.75 0 0 0 6.9 1.58L8 2.68V2.5Z");
		}
		/** Chevron used for both collapse directions. */
		function IconChevron(up) {
			return icon(up ? "M8 5.2 3.6 9.6a.75.75 0 0 0 1.06 1.06L8 7.32l3.34 3.34a.75.75 0 1 0 1.06-1.06L8 5.2Z" : "M8 10.8l4.4-4.4a.75.75 0 1 0-1.06-1.06L8 8.68 4.66 5.34A.75.75 0 0 0 3.6 6.4L8 10.8Z");
		}
		//#endregion

		//#region view
		/**
		 * The live usage panel body.
		 * @param props - session-scope kit: `useProjection`, `sessionId`, and the `usage-hud` translator.
		 * @returns the collapsed pill or the expanded panel.
		 */
		function HudBody({ useProjection, t }) {
			var usage = useProjection("tokenUsage");
			var pressure = useProjection("contextPressure");
			var breakdown = useProjection("contextBreakdown");
			var stats = useProjection("sessionStats");
			var modelSelection = useProjection("modelSelection");
			var costSplit = useProjection("usageCost");

			var prefsPair = useState(readPrefs);
			var prefs = prefsPair[0];
			var setPrefs = prefsPair[1];

			var balancePair = useState({ phase: "loading" });
			var balance = balancePair[0];
			var setBalance = balancePair[1];

			var pricingPair = useState({ phase: "loading" });
			var pricing = pricingPair[0];
			var setPricing = pricingPair[1];

			/** True while spend has outrun the balance reading on screen. */
			var stalePair = useState(false);
			var stale = stalePair[0];
			var setStale = stalePair[1];

			/** Pending scheduled balance read, so a burst of samples coalesces into one. */
			var lastTotalRef = useRef(undefined);

			var dragRef = useRef(null);
			/** Whether the current gesture actually travelled, so its click is ignored. */
			var draggedRef = useRef(false);
			var mountedRef = useRef(true);
			/** The floating layer itself, measured so the clamp knows its real size. */
			var rootRef = useRef(null);

			useEffect(function () {
				mountedRef.current = true;
				return function () {
					mountedRef.current = false;
				};
			}, []);

			/** Measured size of the floating layer, with a safe guess before first paint. */
			var measureRoot = useCallback(function () {
				var element = rootRef.current;
				if (element === null || element === undefined) return { width: 300, height: 240 };
				var rect = element.getBoundingClientRect();
				return {
					width: rect.width > 0 ? rect.width : 300,
					height: rect.height > 0 ? rect.height : 240
				};
			}, []);

			/**
			 * Pull the stored offsets back inside the viewport, writing only when
			 * something actually moved so this cannot re-render in a loop.
			 */
			var reclamp = useCallback(function () {
				setPrefs(function (previous) {
					var next = clampOffsets(previous, measureRoot(), viewportSize());
					if (next.right === previous.right && next.bottom === previous.bottom) return previous;
					var merged = Object.assign({}, previous, next);
					writePrefs(merged);
					return merged;
				});
			}, [measureRoot]);

			/** Read the host balance route now; `force` bypasses the host's cache. */
			var runBalance = useCallback(function (force) {
				setBalance(function (previous) {
					return { phase: "loading", at: previous.at, payload: previous.payload };
				});
				var request = fetch(BALANCE_URL + (force === true ? "?refresh=1" : ""), { headers: { accept: "application/json" } });
				request.then(function (response) {
					return response.json();
				}).then(function (payload) {
					if (!mountedRef.current) return;
					setBalance({ phase: "done", at: Date.now(), payload: payload });
					if (payload === null || typeof payload !== "object" || payload.ok !== true) return;
					var settled = payload.total !== lastTotalRef.current;
					lastTotalRef.current = payload.total;
					// An unchanged total right after a spend means the provider has not
					// booked the charge yet; the scheduler asks again rather than leaving
					// the panel a full idle period out of date.
					if (!schedulerRef.current.onSettled(settled)) setStale(false);
				}).catch(function (error) {
					if (!mountedRef.current) return;
					setBalance({ phase: "error", message: String(error !== null && error !== undefined && error.message !== undefined ? error.message : error) });
				});
			}, []);

			/** The cadence policy; created once so its timers survive re-renders. */
			var schedulerRef = useRef(undefined);
			if (schedulerRef.current === undefined) {
				schedulerRef.current = createBalanceScheduler({
					run: runBalance,
					now: function () {
						return Date.now();
					},
					setTimeout: function (fn, delay) {
						return setTimeout(fn, delay);
					},
					clearTimeout: function (handle) {
						clearTimeout(handle);
					}
				});
			}

			/**
			 * Read the host price table. Static data, so one success is enough;
			 * the poll retries only while it is still missing.
			 * @returns whether a usable table arrived.
			 */
			var refreshPricing = useCallback(function () {
				return fetch(PRICING_URL, { headers: { accept: "application/json" } }).then(function (response) {
					return response.json();
				}).then(function (payload) {
					if (!mountedRef.current) return false;
					setPricing({ phase: "done", payload: payload });
					return payload !== null && typeof payload === "object" && payload.ok === true;
				}).catch(function (error) {
					if (!mountedRef.current) return false;
					setPricing({ phase: "error", message: String(error !== null && error !== undefined && error.message !== undefined ? error.message : error) });
					return false;
				});
			}, []);

			useEffect(function () {
				var havePricing = false;
				// One read at mount, then a slow floor. The floor only asks for a
				// cached read: if nothing has been spent there is nothing to force.
				schedulerRef.current.onIdle();
				refreshPricing().then(function (ok) {
					havePricing = ok;
				});
				var timer = setInterval(function () {
					schedulerRef.current.onIdle();
					if (!havePricing) {
						refreshPricing().then(function (ok) {
							havePricing = ok;
						});
					}
				}, BALANCE_INTERVAL_MS);
				return function () {
					clearInterval(timer);
					schedulerRef.current.dispose();
				};
			}, [refreshPricing]);

			/** Persist one preference change and return the merged value. */
			var update = useCallback(function (patch) {
				setPrefs(function (previous) {
					var next = Object.assign({}, previous, patch, { placed: true });
					writePrefs(next);
					return next;
				});
			}, []);

			/**
			 * First placement only: anchor the panel to the top-right, using its
			 * measured height so the whole layer lands inside the viewport. Once a
			 * position has been stored, the user's own placement wins forever.
			 */
			useEffect(function () {
				if (prefs.placed) return;
				var size = measureRoot();
				update({ right: EDGE + 8, bottom: Math.max(EDGE, viewportSize().height - size.height - EDGE) });
			}, [prefs.placed, update, measureRoot]);

			// Keep the layer inside the viewport as the window resizes and as the
			// panel's own height changes (collapse, expand, rows appearing). A
			// position that was valid when stored can become unreachable later, and
			// an off-screen header is exactly what makes the panel undraggable.
			useEffect(function () {
				reclamp();
				globalThis.addEventListener("resize", reclamp);
				var observer = typeof globalThis.ResizeObserver === "function" ? new globalThis.ResizeObserver(reclamp) : undefined;
				if (observer !== undefined && rootRef.current !== null) observer.observe(rootRef.current);
				return function () {
					globalThis.removeEventListener("resize", reclamp);
					if (observer !== undefined) observer.disconnect();
				};
			}, [reclamp]);

			/** Re-measure after a collapse or expand, whose height change is large. */
			useEffect(function () {
				reclamp();
			}, [reclamp, prefs.collapsed]);

			/**
			 * Begin a drag. The expanded panel is dragged by its header, where a
			 * press on a button must not start a drag; the collapsed pill IS the
			 * handle, so there the press is allowed on the button itself.
			 * @param event - the pointerdown event.
			 * @param allowButton - true when the pressed element may be a button.
			 */
			var beginDrag = useCallback(function (event, allowButton) {
				draggedRef.current = false;
				if (event.button !== 0) return;
				if (!allowButton && event.target !== null && event.target.closest !== undefined && event.target.closest("button") !== null) return;
				dragRef.current = { startX: event.clientX, startY: event.clientY, startRight: prefs.right, startBottom: prefs.bottom };
				if (event.currentTarget.setPointerCapture !== undefined) {
					try {
						event.currentTarget.setPointerCapture(event.pointerId);
					} catch (error) {}
				}
				// Suppressing the default on the pill would fight its own click.
				if (!allowButton) event.preventDefault();
			}, [prefs.right, prefs.bottom]);

			/** Track travel (so a click can be told from a drag) and move the layer. */
			var onDragMove = useCallback(function (event) {
				var drag = dragRef.current;
				if (drag === null) return;
				if (Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY) > DRAG_THRESHOLD) draggedRef.current = true;
				update(clampOffsets({
					right: drag.startRight - (event.clientX - drag.startX),
					bottom: drag.startBottom - (event.clientY - drag.startY)
				}, measureRoot(), viewportSize()));
			}, [update, measureRoot]);

			var onDragEnd = useCallback(function () {
				dragRef.current = null;
			}, []);

			/**
			 * Expand on a click, but not on the click that ends a drag: the pill is
			 * both the handle and the expand control, so a drag must not also toggle.
			 */
			var onPillClick = useCallback(function () {
				if (draggedRef.current) {
					draggedRef.current = false;
					return;
				}
				update({ collapsed: false });
			}, [update]);

			var totals = usage === undefined ? undefined : usage;
			var billedInput = totals === undefined ? 0 : totals.uncachedInputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
			var hitRate = billedInput > 0 ? totals.cacheReadTokens / billedInput : null;
			var grandTotal = totals === undefined ? 0 : billedInput + totals.outputTokens;

			var usedTokens = pressure === undefined ? undefined : pressure.projectedTokens !== undefined ? pressure.projectedTokens : pressure.pressureTokens;
			var contextWindow = pressure === undefined ? undefined : pressure.contextWindow;
			var hasContext = typeof usedTokens === "number" && typeof contextWindow === "number" && contextWindow > 0;
			var percent = hasContext ? Math.min(100, Math.round(usedTokens / contextWindow * 100)) : null;

			/** Composition segments scaled into the occupied part of the ring. */
			var segments = useMemo(function () {
				if (percent === null) return [];
				if (breakdown === undefined) return [{ key: "total", className: null, width: percent }];
				var parts = [
					{ key: "system", className: "dshUh_system", value: breakdown.systemTokens },
					{ key: "tools", className: "dshUh_tools", value: breakdown.toolsTokens },
					{ key: "messages", className: "dshUh_messages", value: breakdown.messageTokens }
				];
				var sum = parts.reduce(function (carry, part) {
					return carry + part.value;
				}, 0);
				if (sum <= 0) return [{ key: "total", className: null, width: percent }];
				return parts.map(function (part) {
					return { key: part.key, className: part.className, width: percent * part.value / sum };
				}).filter(function (part) {
					return part.width > 0;
				});
			}, [percent, breakdown]);

			var balancePayload = balance.payload;
			var balanceOk = balancePayload !== undefined && balancePayload.ok === true;
			var balanceSource = keySourceLabel(balancePayload, t);
			var balanceText;
			if (balance.phase === "loading" && balancePayload === undefined) balanceText = t("balance.loading");
			else if (balance.phase === "error") balanceText = t("balance.error");
			else if (balanceOk) balanceText = formatMoney(balancePayload.total, balancePayload.currency, t);
			else if (balancePayload !== undefined && balancePayload.code === "NO_CREDENTIAL") balanceText = t("balance.unavailable");
			else balanceText = t("balance.error");

			var contextText = percent === null ? t("context.unknown") : percent + "%";
			var cacheText = hitRate === null ? t("cache.none") : (Math.round(hitRate * 1000) / 10) + "%";
			var tokenText = totals === undefined ? "—" : formatTokens(grandTotal, t);

			/** The model that last served this session, per its own projection. */
			var billedModel = modelSelection === undefined || modelSelection === null ? undefined
				: modelSelection.lastUsed !== null && modelSelection.lastUsed !== undefined ? modelSelection.lastUsed.model
					: modelSelection.next !== null && modelSelection.next !== undefined ? modelSelection.next.model : undefined;

			var pricingPayload = pricing.payload;
			var pricingOk = pricingPayload !== undefined && pricingPayload.ok === true;
			var pricingModels = pricingOk && pricingPayload.models !== undefined && pricingPayload.models !== null ? pricingPayload.models : {};
			var pricedModel = pricingOk ? pricedModelFor(pricingModels, billedModel, pricingPayload.defaultModel) : undefined;
			var rateSet;
			if (pricedModel !== undefined) {
				var regimes = pricingModels[pricedModel.id] || {};
				rateSet = regimes[pricingPayload.regime] || regimes.offPeak || regimes.peak;
			}
			var cost = costOf(totals, rateSet, pricingOk ? pricingPayload.unit : undefined);
			// Two sources, one shape. The host's `usageCost` projection prices every
			// request at the regime and model in force when it was consumed, so it is
			// exact; the local single-regime estimate is the fallback for assemblies
			// without the projection, and says so.
			var split = costSplit !== undefined && costSplit !== null && Number.isFinite(costSplit.total) && costSplit.samples > 0 ? costSplit : undefined;
			var costView = split === undefined
				? cost === undefined ? undefined : {
					total: cost.total,
					byBucket: cost.parts,
					regimeSplit: undefined,
					models: pricedModel === undefined ? [] : [pricedModel.id],
					exactModel: pricedModel === undefined ? undefined : pricedModel.exact,
					unpriced: cost.complete !== true,
					regime: pricingOk ? pricingPayload.regime : undefined
				}
				: {
					total: split.total,
					byBucket: split.byBucket,
					regimeSplit: split.byRegime,
					models: split.byModel.map(function (entry) { return entry.model; }),
					exactModel: true,
					unpriced: split.unpricedModels.length > 0,
					regime: undefined
				};
			// Three distinct states, deliberately not collapsed into one: no price
			// table, a price table but no usage sample yet, and a real figure.
			var costText = !pricingOk && split === undefined ? t("cost.none") : costView === undefined ? "—" : formatCost(costView.total, t);
			var regimeLabel = !pricingOk ? t("cost.regime.unknown") : pricingPayload.regime === "peak" ? t("cost.regime.peak") : t("cost.regime.offPeak");
			/** The three headline rates, so the figure can be sanity-checked in place. */
			var rateText = rateSet === undefined ? "" : t("cost.rate", {
				cached: rateSet.inputCached === undefined ? "—" : String(rateSet.inputCached),
				uncached: rateSet.inputUncached === undefined ? "—" : String(rateSet.inputUncached),
				output: rateSet.output === undefined ? "—" : String(rateSet.output)
			});
			/**
			 * Either the per-regime split the host computed, or the single rate
			 * used. The window label always renders, including when there is no
			 * figure yet — "which rate applied" is exactly what a reader needs to
			 * know when the number is missing.
			 */
			var basisLine = costView !== undefined && costView.regimeSplit !== undefined
				? h("div", { className: "dshUh_split" },
					h("span", { className: "dshUh_hint" }, costView.models.length === 0 ? t("cost.unpriced") : t("cost.models", { models: costView.models.join("、") })),
					h("span", { className: "dshUh_hint" }, t("cost.split", { peak: formatCost(costView.regimeSplit.peak.cost, t), offPeak: formatCost(costView.regimeSplit.offPeak.cost, t) })))
				: h("div", { className: "dshUh_split" },
					costView === undefined || costView.models.length === 0 ? null : h("span", { className: "dshUh_hint" }, t(costView.exactModel === true ? "cost.model" : "cost.defaultModel", { model: costView.models.join("、") })),
					h("span", { className: "dshUh_hint" }, regimeLabel));
			var basisNote = costView === undefined ? null : t(costView.regimeSplit === undefined ? "cost.hint" : "cost.hint.split");

			// Spending is what makes a balance stale, so spending is what triggers
			// the next read: a rising cost marks the figure on screen out of date
			// and schedules a forced re-read once the burst settles. Without this
			// the panel could sit a full poll period behind its own cost figure.
			var costSignal = costView === undefined ? undefined : costView.total;
			var costRef = useRef(undefined);
			useEffect(function () {
				if (costSignal === undefined) return;
				var previous = costRef.current;
				costRef.current = costSignal;
				if (previous === undefined || costSignal <= previous) return;
				setStale(true);
				schedulerRef.current.onSpend();
			}, [costSignal]);

			/** One pill cell: a tertiary label plus a primary value. */
			function pillCell(key, label, value) {
				return h("span", { className: "dshUh_pillItem", key: key }, h("span", { className: "dshUh_pillKey" }, label), h("span", { className: "dshUh_pillValue" }, value));
			}

			if (prefs.collapsed) {
				return h("div", {
					ref: rootRef,
					className: "dshUh_root",
					style: { right: prefs.right + "px", bottom: prefs.bottom + "px" }
				}, h("button", {
					type: "button",
					className: "dshUh_pill",
					"aria-label": t("hud.expand"),
					title: t("hud.expand"),
					// The pill is its own drag handle: press and move to reposition,
					// press and release in place to expand.
					onPointerDown: function (event) {
						beginDrag(event, true);
					},
					onPointerMove: onDragMove,
					onPointerUp: onDragEnd,
					onPointerCancel: onDragEnd,
					onClick: onPillClick
				}, pillCell("balance", t("pill.balance"), balanceText), pillCell("cost", t("pill.cost"), costText), pillCell("cache", t("pill.cache"), cacheText), pillCell("context", t("pill.context"), contextText), pillCell("tokens", t("pill.tokens"), tokenText)));
			}

			var bodyChildren = [];

			// ── balance ──────────────────────────────────────────────────────────
			bodyChildren.push(h("section", { className: "dshUh_section", key: "balance" },
				h("div", { className: "dshUh_sectionHead" },
					h("span", { className: "dshUh_sectionTitle" }, t("balance.label")),
					h("span", { className: balanceOk && !stale ? "dshUh_strong dshUh_good" : "dshUh_strong dshUh_warn" }, balanceText)
				),
				balanceOk ? h("dl", { className: "dshUh_rows" },
					h("div", { className: "dshUh_row", key: "granted" }, h("dt", null, t("balance.granted")), h("dd", null, formatMoney(balancePayload.granted, balancePayload.currency, t))),
					h("div", { className: "dshUh_row", key: "topped" }, h("dt", null, t("balance.toppedUp")), h("dd", null, formatMoney(balancePayload.toppedUp, balancePayload.currency, t))),
					h("div", { className: "dshUh_row", key: "at" }, h("dt", null, t("balance.updated")), h("dd", null, formatDuration(Date.now() - balancePayload.fetchedAt, t)), h("span", { className: "dshUh_hint", title: balancePayload.baseURL }, balanceSource))
				) : h("div", { className: "dshUh_hint" },
					h("span", null, balance.phase === "error" ? String(balance.message) : String(balancePayload !== undefined && balancePayload.message !== undefined ? balancePayload.message : "")),
					balanceSource.length > 0 ? h("span", null, " · " + balanceSource) : null
				),
				balanceOk && stale ? h("div", { className: "dshUh_hint dshUh_warn" }, t("balance.stale")) : null
			));

			// ── context ──────────────────────────────────────────────────────────
			bodyChildren.push(h("div", { className: "dshUh_divider", key: "d1" }));
			bodyChildren.push(h("section", { className: "dshUh_section", key: "context" },
				h("div", { className: "dshUh_sectionHead" },
					h("span", { className: "dshUh_sectionTitle" }, t("context.label")),
					h("span", { className: hasContext ? "dshUh_strong dshUh_good" : "dshUh_strong" }, contextText),
					hasContext ? h("span", { className: "dshUh_hint" }, t("context.used", { used: formatTokens(usedTokens, t), total: formatTokens(contextWindow, t) })) : null
				),
				hasContext ? h("div", { className: "dshUh_bar" }, segments.map(function (segment) {
					return h("div", { key: segment.key, className: "dshUh_seg" + (segment.className === null ? "" : " " + segment.className), style: { width: segment.width + "%" } });
				})) : null,
				breakdown === undefined ? null : h("dl", { className: "dshUh_rows" },
					h("div", { className: "dshUh_row", key: "system" }, h("dt", null, h("span", { className: "dshUh_swatch dshUh_system" }), t("context.system")), h("dd", null, formatTokens(breakdown.systemTokens, t))),
					h("div", { className: "dshUh_row", key: "tools" }, h("dt", null, h("span", { className: "dshUh_swatch dshUh_tools" }), t("context.tools")), h("dd", null, formatTokens(breakdown.toolsTokens, t))),
					h("div", { className: "dshUh_row", key: "messages" }, h("dt", null, h("span", { className: "dshUh_swatch dshUh_messages" }), t("context.messages")), h("dd", null, formatTokens(breakdown.messageTokens, t)))
				)
			));

			// ── tokens ───────────────────────────────────────────────────────────
			bodyChildren.push(h("div", { className: "dshUh_divider", key: "d2" }));
			bodyChildren.push(h("section", { className: "dshUh_section", key: "tokens" },
				h("div", { className: "dshUh_sectionHead" },
					h("span", { className: "dshUh_sectionTitle" }, t("tokens.label")),
					h("span", { className: "dshUh_strong dshUh_good" }, tokenText)
				),
				h("dl", { className: "dshUh_rows" },
					h("div", { className: "dshUh_row", key: "in" }, h("dt", null, t("tokens.input")), h("dd", null, totals === undefined ? "—" : formatTokens(totals.uncachedInputTokens, t))),
					h("div", { className: "dshUh_row", key: "out" }, h("dt", null, t("tokens.output")), h("dd", null, totals === undefined ? "—" : formatTokens(totals.outputTokens, t))),
					h("div", { className: "dshUh_row", key: "read" }, h("dt", null, t("tokens.cacheRead")), h("dd", null, totals === undefined ? "—" : formatTokens(totals.cacheReadTokens, t))),
					h("div", { className: "dshUh_row", key: "write" }, h("dt", null, t("tokens.cacheWrite")), h("dd", null, totals === undefined ? "—" : formatTokens(totals.cacheWriteTokens, t)))
				)
			));

			// ── cost ─────────────────────────────────────────────────────────────
			bodyChildren.push(h("div", { className: "dshUh_divider", key: "d3" }));
			bodyChildren.push(h("section", { className: "dshUh_section", key: "cost" },
				h("div", { className: "dshUh_sectionHead" },
					h("span", { className: "dshUh_sectionTitle" }, t("cost.label")),
					h("span", { className: cost === undefined ? "dshUh_strong" : "dshUh_strong dshUh_good" }, costText)
				),
				h("dl", { className: "dshUh_rows" },
					h("div", { className: "dshUh_row", key: "cached" }, h("dt", null, t("cost.part.cached")), h("dd", null, costView === undefined ? "—" : formatCost(costView.byBucket.cached, t))),
					h("div", { className: "dshUh_row", key: "uncached" }, h("dt", null, t("cost.part.uncached")), h("dd", null, costView === undefined ? "—" : formatCost(costView.byBucket.uncached, t))),
					h("div", { className: "dshUh_row", key: "output" }, h("dt", null, t("cost.part.output")), h("dd", null, costView === undefined ? "—" : formatCost(costView.byBucket.output, t))),
					h("div", { className: "dshUh_row", key: "cacheWrite" }, h("dt", null, t("cost.part.cacheWrite")), h("dd", null, costView === undefined ? "—" : formatCost(costView.byBucket.cacheWrite, t)))
				),
				basisLine,
				rateText.length > 0 ? h("div", { className: "dshUh_hint" }, rateText) : null,
				basisNote === null ? null : h("div", { className: "dshUh_hint" }, basisNote),
				costView !== undefined && costView.unpriced ? h("div", { className: "dshUh_hint dshUh_warn" }, t("cost.incomplete")) : null
			));

			// ── cache + session ──────────────────────────────────────────────────
			bodyChildren.push(h("div", { className: "dshUh_divider", key: "d4" }));
			bodyChildren.push(h("section", { className: "dshUh_section", key: "cache" },
				h("div", { className: "dshUh_sectionHead" },
					h("span", { className: "dshUh_sectionTitle" }, t("cache.label")),
					h("span", { className: "dshUh_strong dshUh_good" }, cacheText)
				),
				stats === undefined ? null : h("div", { className: "dshUh_split" },
					h("span", { className: "dshUh_hint" }, t("stats.value", { turns: String(stats.turns), steps: String(stats.steps) })),
					h("span", { className: "dshUh_hint" }, t("stats.time", { time: formatDuration(stats.llmMs, t) }))
				)
			));

			return h("div", {
				ref: rootRef,
				className: "dshUh_root",
				style: { right: prefs.right + "px", bottom: prefs.bottom + "px" }
			}, h("div", { className: "dshUh_panel", role: "region", "aria-label": t("hud.aria") },
				h("div", {
					className: "dshUh_head",
					onPointerDown: function (event) {
						beginDrag(event, false);
					},
					onPointerMove: onDragMove,
					onPointerUp: onDragEnd,
					onPointerCancel: onDragEnd,
					title: t("hud.drag")
				},
					h("span", { className: "dshUh_title" }, t("hud.title")),
					h("button", { type: "button", className: "dshUh_iconBtn", "aria-label": t("hud.refresh"), title: t("hud.refresh"), onClick: function () { setStale(false); schedulerRef.current.onManual(); } }, h(IconRefresh, null)),
					h("button", { type: "button", className: "dshUh_iconBtn", "aria-label": t("hud.collapse"), title: t("hud.collapse"), onClick: function () { update({ collapsed: true }); } }, h(IconChevron, { up: false }))
				),
				h("div", { className: "dshUh_body" }, bodyChildren)
			));
		}

		/**
		 * Slot entry point. The floating layer is portalled onto `document.body`
		 * so no composer ancestor's own positioning can clip or re-anchor it;
		 * without a portal the same tree renders in place.
		 * @param props - session-scope kit plus the `usage-hud` translator.
		 * @returns the portalled HUD, or the HUD in place when no portal exists.
		 */
		function UsageHud(props) {
			var hostPair = useState(function () {
				var element = document.createElement("div");
				element.dataset.dshUsageHud = "";
				return element;
			});
			var host = hostPair[0];
			useEffect(function () {
				document.body.appendChild(host);
				return function () {
					if (host.parentNode !== null) host.parentNode.removeChild(host);
				};
			}, [host]);
			if (!PORTAL) return h(HudBody, props);
			return ReactDOM.createPortal(h(HudBody, props), host);
		}
		//#endregion

		//#region locales
		var zh = {
			"hud.aria": "实时用量看板",
			"hud.title": "用量看板",
			"hud.expand": "展开用量看板",
			"hud.collapse": "收起用量看板",
			"hud.refresh": "立即刷新余额",
			"hud.drag": "拖动可移动位置",
			"pill.balance": "余额",
			"pill.cost": "费用",
			"pill.cache": "命中",
			"pill.context": "上下文",
			"pill.tokens": "Token",
			"balance.label": "API 余额",
			"balance.loading": "查询中…",
			"balance.unavailable": "无可用密钥",
			"balance.error": "查询失败",
			"balance.granted": "赠送额度",
			"balance.toppedUp": "充值余额",
			"balance.updated": "数据时间",
			"balance.stale": "费用已增加，正在重新查询余额",
			"balance.source.env": "来自环境变量",
			"balance.source.file": "来自凭据文件",
			"balance.source.dotenv": "来自 .env",
			"balance.source.credentials": "来自凭据服务",
			"context.label": "上下文占用",
			"context.used": "已用 {used} / {total}",
			"context.unknown": "暂无数据",
			"context.system": "系统提示",
			"context.tools": "工具定义",
			"context.messages": "对话消息",
			"tokens.label": "Token 消耗",
			"tokens.input": "输入（未命中缓存）",
			"tokens.output": "输出",
			"tokens.cacheRead": "缓存命中读取",
			"tokens.cacheWrite": "缓存写入",
			"cost.label": "预估费用",
			"cost.none": "暂无单价",
			"cost.unpriced": "无该模型单价",
			"cost.model": "按 {model} 单价",
			"cost.defaultModel": "按 {model}（默认）单价",
			"cost.regime.peak": "高峰计价",
			"cost.regime.offPeak": "空闲计价",
			"cost.regime.unknown": "计价时段未知",
			"cost.part.cached": "缓存命中读",
			"cost.part.uncached": "未命中输入",
			"cost.part.output": "输出",
			"cost.part.cacheWrite": "缓存写入",
			"cost.rate": "命中 {cached} · 未命中 {uncached} · 输出 {output} 元/百万",
			"cost.split": "高峰 {peak} · 空闲 {offPeak}",
			"cost.models": "按 {models} 单价",
			"cost.incomplete": "部分单价未配置，费用偏低",
			"cost.hint": "按当前计价时段估算，非账单金额",
			"cost.hint.split": "按各请求实际消耗时段分档计价，非账单金额",
			"cache.label": "缓存命中率",
			"cache.none": "暂无数据",
			"stats.value": "{turns} 轮 · {steps} 步",
			"stats.time": "模型耗时 {time}",
			"unit.thousand": "{value}k",
			"unit.million": "{value}M",
			"duration.seconds": "{seconds}秒",
			"duration.minutes": "{minutes}分{seconds}秒",
			"duration.hours": "{hours}小时{minutes}分",
			"money.cny": "¥{amount}",
			"money.usd": "${amount}",
			"money.other": "{amount} {currency}"
		};
		var en = {
			"hud.aria": "Live usage panel",
			"hud.title": "Usage",
			"hud.expand": "Expand the usage panel",
			"hud.collapse": "Collapse the usage panel",
			"hud.refresh": "Refresh the balance now",
			"hud.drag": "Drag to move",
			"pill.balance": "bal",
			"pill.cost": "cost",
			"pill.cache": "hit",
			"pill.context": "ctx",
			"pill.tokens": "tok",
			"balance.label": "API balance",
			"balance.loading": "checking…",
			"balance.unavailable": "no credential",
			"balance.error": "unavailable",
			"balance.granted": "Granted",
			"balance.toppedUp": "Topped up",
			"balance.updated": "Age",
			"balance.stale": "spend changed; re-reading the balance",
			"balance.source.env": "from environment",
			"balance.source.file": "from credential store",
			"balance.source.dotenv": "from .env",
			"balance.source.credentials": "from credentials service",
			"context.label": "Context occupancy",
			"context.used": "{used} / {total} used",
			"context.unknown": "no data yet",
			"context.system": "System prompt",
			"context.tools": "Tool schemas",
			"context.messages": "Messages",
			"tokens.label": "Token consumption",
			"tokens.input": "Input (uncached)",
			"tokens.output": "Output",
			"tokens.cacheRead": "Cache read",
			"tokens.cacheWrite": "Cache write",
			"cost.label": "Estimated cost",
			"cost.none": "no rates",
			"cost.unpriced": "model not priced",
			"cost.model": "at {model} rates",
			"cost.defaultModel": "at {model} (default) rates",
			"cost.regime.peak": "peak rate",
			"cost.regime.offPeak": "off-peak rate",
			"cost.regime.unknown": "billing window unknown",
			"cost.part.cached": "Cache hit read",
			"cost.part.uncached": "Uncached input",
			"cost.part.output": "Output",
			"cost.part.cacheWrite": "Cache write",
			"cost.rate": "hit {cached} · miss {uncached} · out {output} CNY/M",
			"cost.split": "peak {peak} · off-peak {offPeak}",
			"cost.models": "at {models} rates",
			"cost.incomplete": "some rates are unset, so this understates",
			"cost.hint": "Estimated at the current billing window; not a bill",
			"cost.hint.split": "Per request, at the window it was consumed in; not a bill",
			"cache.label": "Prompt-cache hit rate",
			"cache.none": "no data yet",
			"stats.value": "{turns} turns · {steps} steps",
			"stats.time": "model time {time}",
			"unit.thousand": "{value}k",
			"unit.million": "{value}M",
			"duration.seconds": "{seconds}s",
			"duration.minutes": "{minutes}m {seconds}s",
			"duration.hours": "{hours}h {minutes}m",
			"money.cny": "¥{amount}",
			"money.usd": "${amount}",
			"money.other": "{amount} {currency}"
		};
		//#endregion

		//#region plugin
		/** Client services this plugin waits for: slot registration and the locale seat. */
		var inject = ["slots", "locale"];

		/**
		 * Register the dictionaries and the composer-overlay entry.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(function () {
				return ctx.locale.register(NS, { zh: zh, en: en });
			}, "usage-hud: dictionaries");
			ctx.slots.inject("conversation.input.overlay", function () {
				return ctx.slots.register({
					name: "conversation.input.overlay",
					id: "usage-hud",
					order: 10,
					locale: NS
				}, UsageHud);
			});
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		/** Pure helpers the offline harness drives directly; never used by the UI. */
		exports.internals = { createBalanceScheduler: createBalanceScheduler, costOf: costOf, formatCost: formatCost, clampOffsets: clampOffsets, viewportSize: viewportSize, EDGE: EDGE, BALANCE_SETTLE_MS: BALANCE_SETTLE_MS, BALANCE_MIN_GAP_MS: BALANCE_MIN_GAP_MS, BALANCE_RETRY_MS: BALANCE_RETRY_MS, BALANCE_RETRY_BUDGET: BALANCE_RETRY_BUDGET };
		return module.exports;
	}
});
