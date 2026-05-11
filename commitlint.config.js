export default {
  extends: ['@commitlint/config-conventional'],
  ignores: [(message) => /^v?\d+\.\d+\.\d+(?:\s|$)/.test(message.trim())],
};
