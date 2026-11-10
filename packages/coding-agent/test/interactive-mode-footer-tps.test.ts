import { describe, expect, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	FOOTER_TPS_CUSTOM_TYPE,
	type FooterTpsSnapshot,
	FooterTpsTracker,
} from "../src/modes/interactive/components/footer-tps.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type FooterTpsHost = {
	sessionManager: SessionManager;
	footerTpsTracker: FooterTpsTracker;
	getPersistedFooterTps: () => FooterTpsSnapshot | undefined;
};

const getPersistedFooterTps = Reflect.get(InteractiveMode.prototype, "getPersistedFooterTps") as (
	this: FooterTpsHost,
) => FooterTpsSnapshot | undefined;
const persistFooterTps = Reflect.get(InteractiveMode.prototype, "persistFooterTps") as (this: FooterTpsHost) => void;

function createHost(sessionManager: SessionManager): FooterTpsHost {
	const host: FooterTpsHost = {
		sessionManager,
		footerTpsTracker: new FooterTpsTracker(),
		getPersistedFooterTps: () => getPersistedFooterTps.call(host),
	};
	return host;
}

function footerTpsEntries(sessionManager: SessionManager) {
	return sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === FOOTER_TPS_CUSTOM_TYPE);
}

describe("InteractiveMode footer tps persistence", () => {
	test("new session starts at 0 and skips saving an unchanged value", () => {
		const sessionManager = SessionManager.inMemory("/tmp");
		const host = createHost(sessionManager);
		host.footerTpsTracker.restore(getPersistedFooterTps.call(host));
		expect(host.footerTpsTracker.getLabel()).toBe("0.0 tps");

		persistFooterTps.call(host);
		expect(footerTpsEntries(sessionManager)).toHaveLength(0);
	});

	test("saves the displayed value and restores the latest one", () => {
		const sessionManager = SessionManager.inMemory("/tmp");
		const host = createHost(sessionManager);
		host.footerTpsTracker.restore({ rate: 50, estimated: false });
		persistFooterTps.call(host);
		persistFooterTps.call(host);
		host.footerTpsTracker.restore({ rate: 80, estimated: false });
		persistFooterTps.call(host);
		expect(footerTpsEntries(sessionManager)).toHaveLength(2);

		const reloaded = createHost(sessionManager);
		reloaded.footerTpsTracker.restore(getPersistedFooterTps.call(reloaded));
		expect(reloaded.footerTpsTracker.getLabel()).toBe("80.0 tps");
	});
});
