"use strict";

/**
 * Responses image generation — bundled first-party plugin.
 *
 * The plugin exists so the skill document and its script ship with the app and
 * still belong to the user: the only behaviour it declares is a contributed
 * skill, so turning the plugin off in Settings > Plugins withdraws the skill
 * exactly like a third-party one. There is no runtime API to call here.
 */

async function onLoad() {}

async function onUnload() {}

module.exports = { onLoad, onUnload };
