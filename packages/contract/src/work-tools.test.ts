import { describe, expect, it } from "vitest";

import { isWorkCall } from "./work-tools";

const GATEWAY = "abacus-connectors";

describe("isWorkCall", () => {
  it.each<[string, Record<string, unknown>, boolean]>([
    // A connector the app runs locally: building and playtesting are work.
    ["roblox-studio_execute_luau", { code: "print(1)" }, true],
    ["roblox-studio_start_stop_play", { mode: "start_play" }, true],
    ["roblox-studio_multi_edit", {}, true],
    // ...looking around it is not.
    ["roblox-studio_get_console_output", {}, false],
    ["roblox-studio_search_game_tree", { query: "Baseplate" }, false],
    ["roblox-studio_script_read", { path: "Workspace.Script" }, false],
    ["roblox-studio_screen_capture", {}, false],
    ["roblox-studio_inspect_instance", {}, false],
    ["roblox-studio_list_roblox_studios", {}, false],
    ["roblox-studio_get_studio_state", {}, false],
    // Gateway connectors: judged by the action.
    [`${GATEWAY}_Gmail_Tool`, { action: "send_email" }, true],
    [`${GATEWAY}_Gmail_Tool`, { action: "search_email" }, false],
    [`${GATEWAY}_Gmail_Tool`, { action: "get_my_info" }, false],
    [`${GATEWAY}_Google_Drive_Tool`, { action: "create_document" }, true],
    [`${GATEWAY}_Google_Drive_Tool`, { action: "list_files" }, false],
    [`${GATEWAY}_Google_Calendar_Tool`, { action: "create_event" }, true],
    [`${GATEWAY}_Google_Calendar_Tool`, { action: "get_free_busy" }, false],
    [`${GATEWAY}_Jira_Tool`, { action: "update_issue" }, true],
    [`${GATEWAY}_Slack_Tool`, { action: "post_message" }, true],
    [`${GATEWAY}_Slack_Tool`, { action: "search_messages" }, false],
    // A server the user added, in its own spelling.
    ["notion_createPage", {}, true],
    ["notion_getPage", {}, false],
    ["github_get_build_status", {}, false],
    ["mystery_server_frobnicate", {}, true],
    // The app's own tools.
    ["bash", { command: "npm test" }, true],
    ["write", { path: "a.txt" }, true],
    ["edit", { path: "a.txt" }, true],
    ["batch_edit", {}, true],
    ["delete", {}, true],
    ["run_tests", {}, true],
    ["image_generate", {}, true],
    ["agent-tools_ppt", {}, true],
    ["agent-tools_document", {}, true],
    ["agent-tools_present_deliverable", {}, true],
    ["serve", { action: "start" }, true],
    ["serve", { action: "list" }, false],
    ["browser_interact", {}, true],
    ["browser_snapshot", {}, false],
    ["browser_navigate", { url: "https://example.com" }, false],
    ["device_screenshot", {}, false],
    ["read", { path: "a.txt" }, false],
    ["batch_file_read", {}, false],
    ["grep", {}, false],
    ["glob", {}, false],
    ["ls", {}, false],
    ["code_map", {}, false],
    ["web_search", { query: "weather" }, false],
    ["web_fetch", { url: "https://example.com" }, false],
    ["x_search", {}, false],
    ["vision_analyze", {}, false],
    ["read_output", {}, false],
    ["todo", {}, false],
    ["memory", { action: "add" }, false],
    ["current_time", {}, false],
    ["agent-tools_paid_feature", {}, false],
    ["agent-tools_billing_plan", {}, false],
    ["agent-tools_suggest_tasks", {}, false],
    ["ask_user_question", {}, false],
  ])("%s %j is work: %s", (name, input, expected) => {
    expect(isWorkCall(name, input)).toBe(expected);
  });
});
