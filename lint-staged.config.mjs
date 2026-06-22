export default {
  'src/**/*.ts': () => 'pnpm typecheck',
  '{src,test}/**/*.ts': 'eslint --fix',
  '*': 'prettier --write --ignore-unknown',
};
