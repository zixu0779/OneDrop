// iOS Edge uses the shared OneDrive and message runtime. Unsupported download
// management APIs are guarded inside the shared background entrypoint.
export { default } from "@onedrop/extension-runtime/background";
