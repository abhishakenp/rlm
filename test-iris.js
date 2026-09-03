const { IrisCommands } = require('./packages/iris-commands/dist/index.js');
const ic = new IrisCommands({});
console.log('handle:', typeof ic.handle);
