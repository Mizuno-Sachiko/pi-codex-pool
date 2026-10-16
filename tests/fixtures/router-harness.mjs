import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export { PoolRouter, CodexConnections, previousResponse } from "../../src/pool-router.mts";

export function eventStream(stream = createAssistantMessageEventStream()) {
	const events = [];
	const push = stream.push.bind(stream);
	stream.push = (event) => {
		events.push(event);
		push(event);
	};
	return Object.assign(stream, { events });
}
