/**
 * One line saying which tool a kind of task belongs to, generated from the
 * connector registry so it cannot drift from what the app actually offers.
 * Without it github.com reads as a website and a pull-request question goes
 * to the browser, whose tool text never mentions connectors.
 */
import { routingPrompt } from "@abacus-ai/connectors/describe";

export const serviceRoutingPrompt = (): string => routingPrompt();
