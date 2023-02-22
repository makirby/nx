import { exec, spawn } from 'child_process';
import { writeFileSync } from 'fs';
import * as enquirer from 'enquirer';
import * as path from 'path';
import { join } from 'path';
import { dirSync } from 'tmp';
import * as yargs from 'yargs';
import { showNxWarning, unparse } from './shared';
import { output } from './output';
import * as ora from 'ora';
import {
  detectInvokedPackageManager,
  generatePackageManagerFiles,
  getPackageManagerCommand,
  getPackageManagerVersion,
  PackageManager,
  packageManagerList,
} from './package-manager';
import { validateNpmPackage } from './validate-npm-package';
import { deduceDefaultBase } from './default-base';
import { getFileName, stringifyCollection } from './utils';
import { yargsDecorator } from './decorator';
import { ciList } from './ci';
import { initializeGitRepo } from './git';
import { messages, recordStat } from './ab-testing';
import chalk = require('chalk');

type Arguments = {
  name: string;
  preset: string;
  appName: string;
  style: string;
  framework: string;
  standaloneApi: boolean;
  docker: boolean;
  nxCloud: boolean;
  routing: boolean;
  allPrompts: boolean;
  packageManager: PackageManager;
  defaultBase: string;
  ci: string;
  skipGit: boolean;
  commit: {
    message: string;
    name: string;
    email: string;
  };
  bundler: 'vite' | 'webpack';
  interactive: boolean;
};

enum Preset {
  Apps = 'apps',
  Empty = 'empty', // same as apps, deprecated
  Core = 'core', // same as npm, deprecated
  NPM = 'npm',
  TS = 'ts',
  WebComponents = 'web-components',
  AngularMonorepo = 'angular-monorepo',
  AngularStandalone = 'angular-standalone',
  ReactMonorepo = 'react-monorepo',
  ReactStandalone = 'react-standalone',
  ReactNative = 'react-native',
  Expo = 'expo',
  NextJs = 'next',
  Nest = 'nest',
  Express = 'express',
  React = 'react',
  Angular = 'angular',
  NodeServer = 'node-server',
}

const presetOptions: { name: Preset; message: string }[] = [
  {
    name: Preset.Apps,
    message:
      'apps              [an empty monorepo with no plugins with a layout that works best for building apps]',
  },
  {
    name: Preset.TS,
    message:
      'ts                [an empty monorepo with the JS/TS plugin preinstalled]',
  },
  {
    name: Preset.ReactMonorepo,
    message: 'react             [a monorepo with a single React application]',
  },
  {
    name: Preset.AngularMonorepo,
    message: 'angular           [a monorepo with a single Angular application]',
  },
  {
    name: Preset.NextJs,
    message: 'next.js           [a monorepo with a single Next.js application]',
  },
  {
    name: Preset.Nest,
    message: 'nest              [a monorepo with a single Nest application]',
  },
  {
    name: Preset.ReactNative,
    message:
      'react-native      [a monorepo with a single React Native application]',
  },
];

const nxVersion = require('../package.json').version;
const tsVersion = 'TYPESCRIPT_VERSION'; // This gets replaced with the typescript version in the root package.json during build
const prettierVersion = 'PRETTIER_VERSION'; // This gets replaced with the prettier version in the root package.json during build

export const commandsObject: yargs.Argv<Arguments> = yargs
  .wrap(yargs.terminalWidth())
  .parserConfiguration({
    'strip-dashed': true,
    'dot-notation': true,
  })
  .command(
    // this is the default and only command
    '$0 [name] [options]',
    'Create a new Nx workspace',
    (yargs) =>
      yargs
        .option('name', {
          describe: chalk.dim`Workspace name (e.g. org name)`,
          type: 'string',
        })
        .option('preset', {
          describe: chalk.dim`Customizes the initial content of your workspace. Default presets include: [${Object.values(
            Preset
          )
            .map((p) => `"${p}"`)
            .join(
              ', '
            )}]. To build your own see https://nx.dev/packages/nx-plugin#preset`,
          type: 'string',
        })
        .option('appName', {
          describe: chalk.dim`The name of the application when a preset with pregenerated app is selected`,
          type: 'string',
        })
        .option('interactive', {
          describe: chalk.dim`Enable interactive mode with presets`,
          type: 'boolean',
        })
        .option('style', {
          describe: chalk.dim`Style option to be used when a preset with pregenerated app is selected`,
          type: 'string',
        })
        .option('standaloneApi', {
          describe: chalk.dim`Use Standalone Components if generating an Angular app`,
          type: 'boolean',
        })
        .option('routing', {
          describe: chalk.dim`Add a routing setup when a preset with pregenerated app is selected`,
          type: 'boolean',
        })
        .option('bundler', {
          describe: chalk.dim`Bundler to be used to build the application`,
          type: 'string',
        })
        .option('framework', {
          describe: chalk.dim`Framework option to be used when the node-server preset is selected`,
          type: 'string',
        })
        .option('docker', {
          describe: chalk.dim`Generate a Dockerfile with your node-server`,
          type: 'boolean',
        })
        .option('nxCloud', {
          describe: chalk.dim(messages.getPromptMessage('nxCloudCreation')),
          type: 'boolean',
        })
        .option('ci', {
          describe: chalk.dim`Generate a CI workflow file`,
          choices: ciList,
          defaultDescription: '',
          type: 'string',
        })
        .option('allPrompts', {
          alias: 'a',
          describe: chalk.dim`Show all prompts`,
          type: 'boolean',
          default: false,
        })
        .option('packageManager', {
          alias: 'pm',
          describe: chalk.dim`Package manager to use`,
          choices: [...packageManagerList].sort(),
          defaultDescription: 'npm',
          type: 'string',
        })
        .option('defaultBase', {
          defaultDescription: 'main',
          describe: chalk.dim`Default base to use for new projects`,
          type: 'string',
        })
        .option('skipGit', {
          describe: chalk.dim`Skip initializing a git repository.`,
          type: 'boolean',
          default: false,
          alias: 'g',
        })
        .option('commit.name', {
          describe: chalk.dim`Name of the committer`,
          type: 'string',
        })
        .option('commit.email', {
          describe: chalk.dim`E-mail of the committer`,
          type: 'string',
        })
        .option('commit.message', {
          describe: chalk.dim`Commit message`,
          type: 'string',
          default: 'Initial commit',
        }),
    async (argv: yargs.ArgumentsCamelCase<Arguments>) => {
      await main(argv).catch((error) => {
        const { version } = require('../package.json');
        output.error({
          title: `Something went wrong! v${version}`,
        });
        throw error;
      });
    },
    [getConfiguration]
  )
  .help('help', chalk.dim`Show help`)
  .updateLocale(yargsDecorator)
  .version(
    'version',
    chalk.dim`Show version`,
    nxVersion
  ) as yargs.Argv<Arguments>;

async function main(parsedArgs: yargs.Arguments<Arguments>) {
  const {
    name,
    preset,
    appName,
    style,
    standaloneApi,
    routing,
    nxCloud,
    packageManager,
    defaultBase,
    ci,
    skipGit,
    commit,
    framework,
    docker,
    bundler,
  } = parsedArgs;

  output.log({
    title: `Nx is creating your v${nxVersion} workspace.`,
    bodyLines: [
      'To make sure the command works reliably in all environments, and that the preset is applied correctly,',
      `Nx will run "${packageManager} install" several times. Please wait.`,
    ],
  });

  const tmpDir = await createSandbox(packageManager);

  const directory = await createApp(
    tmpDir,
    name,
    packageManager as PackageManager,
    {
      ...parsedArgs,
      preset,
      appName,
      style,
      routing,
      standaloneApi,
      nxCloud,
      defaultBase,
      framework,
      docker,
      bundler,
    }
  );

  if (!isKnownPreset(parsedArgs.preset)) {
    await createPreset(parsedArgs, packageManager as PackageManager, directory);
  }

  let nxCloudInstallRes;
  if (nxCloud) {
    nxCloudInstallRes = await setupNxCloud(
      name,
      packageManager as PackageManager
    );
  }
  if (ci) {
    await setupCI(
      name,
      ci,
      packageManager as PackageManager,
      nxCloud && nxCloudInstallRes.code === 0
    );
  }
  if (!skipGit) {
    try {
      await initializeGitRepo(directory, { defaultBase, commit });
    } catch (e) {
      output.error({
        title: 'Could not initialize git repository',
        bodyLines: [e.message],
      });
    }
  }

  showNxWarning(name);
  pointToTutorialAndCourse(preset as Preset);

  if (nxCloud && nxCloudInstallRes.code === 0) {
    printNxCloudSuccessMessage(nxCloudInstallRes.stdout);
  }

  await recordStat({
    nxVersion,
    command: 'create-nx-workspace',
    useCloud: nxCloud,
    meta: messages.codeOfSelectedPromptMessage('nxCloudCreation'),
  });
}

async function getConfiguration(
  argv: yargs.Arguments<Arguments>
): Promise<void> {
  try {
    let name,
      appName,
      style,
      preset,
      framework,
      bundler,
      docker,
      routing,
      standaloneApi;

    output.log({
      title:
        "Let's create a new workspace [https://nx.dev/getting-started/intro]",
    });

    const thirdPartyPreset = await determineThirdPartyPackage(argv);
    if (thirdPartyPreset) {
      preset = thirdPartyPreset;
      name = await determineRepoName(argv);
      appName = '';
      style = null;
    } else {
      if (!argv.preset) {
        const monorepoStyle = await determineMonorepoStyle();
        if (monorepoStyle === 'package-based') {
          preset = 'npm';
        } else if (monorepoStyle === 'react') {
          preset = Preset.ReactStandalone;
        } else if (monorepoStyle === 'angular') {
          preset = Preset.AngularStandalone;
        } else if (monorepoStyle === 'node-server') {
          preset = Preset.NodeServer;
        } else {
          preset = await determinePreset(argv);
        }
      } else if (argv.preset === 'react') {
        preset = await monorepoOrStandalone('react');
      } else if (argv.preset === 'angular') {
        preset = await monorepoOrStandalone('angular');
      } else {
        preset = argv.preset;
      }

      if (
        preset === Preset.ReactStandalone ||
        preset === Preset.AngularStandalone ||
        preset === Preset.NodeServer
      ) {
        appName =
          argv.appName ?? argv.name ?? (await determineAppName(preset, argv));
        name = argv.name ?? appName;

        if (preset === Preset.NodeServer) {
          framework = await determineFramework(argv);
          docker = await determineDockerfile(argv);
        }

        if (preset === Preset.ReactStandalone) {
          bundler = await determineBundler(argv);
        }

        if (preset === Preset.AngularStandalone) {
          standaloneApi =
            argv.standaloneApi ??
            (argv.interactive ? await determineStandaloneApi(argv) : false);
          routing =
            argv.routing ??
            (argv.interactive ? await determineRouting(argv) : true);
        }
      } else {
        name = await determineRepoName(argv);
        appName = await determineAppName(preset, argv);
        if (preset === Preset.ReactMonorepo) {
          bundler = await determineBundler(argv);
        }

        if (preset === Preset.AngularMonorepo) {
          standaloneApi =
            argv.standaloneApi ??
            (argv.interactive ? await determineStandaloneApi(argv) : false);
          routing =
            argv.routing ??
            (argv.interactive ? await determineRouting(argv) : true);
        }
      }
      style = await determineStyle(preset, argv);
    }

    const packageManager = await determinePackageManager(argv);
    const defaultBase = await determineDefaultBase(argv);
    const nxCloud = await determineNxCloud(argv);
    const ci = await determineCI(argv, nxCloud);

    Object.assign(argv, {
      name,
      preset,
      appName,
      style,
      standaloneApi,
      routing,
      framework,
      nxCloud,
      packageManager,
      defaultBase,
      ci,
      bundler,
      docker,
    });
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

function determineRepoName(
  parsedArgs: yargs.Arguments<Arguments>
): Promise<string> {
  const repoName: string = parsedArgs._[0]
    ? parsedArgs._[0].toString()
    : parsedArgs.name;

  if (repoName) {
    return Promise.resolve(repoName);
  }

  return enquirer
    .prompt([
      {
        name: 'RepoName',
        message: `Repository name                      `,
        type: 'input',
      },
    ])
    .then((a: { RepoName: string }) => {
      if (!a.RepoName) {
        output.error({
          title: 'Invalid repository name',
          bodyLines: [`Repository name cannot be empty`],
        });
        process.exit(1);
      }
      return a.RepoName;
    });
}

function monorepoOrStandalone(preset: string): Promise<string> {
  return enquirer
    .prompt([
      {
        name: 'MonorepoOrStandalone',
        message: `--preset=${preset} has been replaced with the following:`,
        type: 'autocomplete',
        choices: [
          {
            name: preset + '-standalone',
            message: `${preset}-standalone: a standalone ${preset} application.`,
          },
          {
            name: preset + '-monorepo',
            message: `${preset}-monorepo:   a monorepo with the apps and libs folders.`,
          },
        ],
      },
    ])
    .then((a: { MonorepoOrStandalone: string }) => {
      if (!a.MonorepoOrStandalone) {
        output.error({
          title: 'Invalid selection',
        });
        process.exit(1);
      }
      return a.MonorepoOrStandalone;
    });
}

function determineMonorepoStyle(): Promise<string> {
  return enquirer
    .prompt([
      {
        name: 'MonorepoStyle',
        message: `Choose what to create                `,
        type: 'autocomplete',
        choices: [
          {
            name: 'package-based',
            message:
              'Package-based monorepo:     Nx makes it fast, but lets you run things your way.',
          },
          {
            name: 'integrated',
            message:
              'Integrated monorepo:        Nx configures your favorite frameworks and lets you focus on shipping features.',
          },
          {
            name: 'react',
            message:
              'Standalone React app:       Nx configures Vite (or Webpack), ESLint, and Cypress.',
          },
          {
            name: 'angular',
            message:
              'Standalone Angular app:     Nx configures Jest, ESLint and Cypress.',
          },
          {
            name: 'node-server',
            message:
              'Standalone Node Server app: Nx configures a framework (ex. Express), esbuild, ESlint and Jest.',
          },
        ],
      },
    ])
    .then((a: { MonorepoStyle: string }) => {
      if (!a.MonorepoStyle) {
        output.error({
          title: 'Invalid monorepo style',
        });
        process.exit(1);
      }
      return a.MonorepoStyle;
    });
}

async function determinePackageManager(
  parsedArgs: yargs.Arguments<Arguments>
): Promise<PackageManager> {
  const packageManager: string = parsedArgs.packageManager;

  if (packageManager) {
    if (packageManagerList.includes(packageManager as PackageManager)) {
      return Promise.resolve(packageManager as PackageManager);
    }
    output.error({
      title: 'Invalid package manager',
      bodyLines: [
        `Package manager must be one of ${stringifyCollection([
          ...packageManagerList,
        ])}`,
      ],
    });
    process.exit(1);
  }

  if (parsedArgs.allPrompts) {
    return enquirer
      .prompt([
        {
          name: 'PackageManager',
          message: `Which package manager to use         `,
          initial: 'npm' as any,
          type: 'autocomplete',
          choices: [
            { name: 'npm', message: 'NPM' },
            { name: 'yarn', message: 'Yarn' },
            { name: 'pnpm', message: 'PNPM' },
          ],
        },
      ])
      .then((a: { PackageManager }) => a.PackageManager);
  }

  return Promise.resolve(detectInvokedPackageManager());
}

async function determineDefaultBase(
  parsedArgs: yargs.Arguments<Arguments>
): Promise<string> {
  if (parsedArgs.defaultBase) {
    return Promise.resolve(parsedArgs.defaultBase);
  }
  if (parsedArgs.allPrompts) {
    return enquirer
      .prompt([
        {
          name: 'DefaultBase',
          message: `Main branch name                   `,
          initial: `main`,
          type: 'input',
        },
      ])
      .then((a: { DefaultBase: string }) => {
        if (!a.DefaultBase) {
          output.error({
            title: 'Invalid branch name',
            bodyLines: [`Branch name cannot be empty`],
          });
          process.exit(1);
        }
        return a.DefaultBase;
      });
  }
  return Promise.resolve(deduceDefaultBase());
}

function isKnownPreset(preset: string): preset is Preset {
  return Object.values(Preset).includes(preset as Preset);
}

async function determineThirdPartyPackage({
  preset,
}: yargs.Arguments<Arguments>) {
  if (preset && !isKnownPreset(preset)) {
    const packageName = preset.match(/.+@/)
      ? preset[0] + preset.substring(1).split('@')[0]
      : preset;
    const validateResult = validateNpmPackage(packageName);
    if (validateResult.validForNewPackages) {
      return Promise.resolve(preset);
    } else {
      //! Error here
      output.error({
        title: 'Invalid preset npm package',
        bodyLines: [
          `There was an error with the preset npm package you provided:`,
          '',
          ...validateResult.errors,
        ],
      });
      process.exit(1);
    }
  } else {
    return Promise.resolve(null);
  }
}

async function determinePreset(parsedArgs: any): Promise<Preset> {
  if (parsedArgs.preset) {
    if (Object.values(Preset).indexOf(parsedArgs.preset) === -1) {
      output.error({
        title: 'Invalid preset',
        bodyLines: [
          `It must be one of the following:`,
          '',
          ...Object.values(Preset),
        ],
      });
      process.exit(1);
    } else {
      return Promise.resolve(parsedArgs.preset);
    }
  }

  return enquirer
    .prompt([
      {
        name: 'Preset',
        message: `What to create in the new workspace  `,
        initial: 'empty' as any,
        type: 'autocomplete',
        choices: presetOptions,
      },
    ])
    .then((a: { Preset: Preset }) => a.Preset);
}

async function determineAppName(
  preset: Preset,
  parsedArgs: yargs.Arguments<Arguments>
): Promise<string> {
  if (
    preset === Preset.Apps ||
    preset === Preset.Core ||
    preset === Preset.TS ||
    preset === Preset.Empty ||
    preset === Preset.NPM
  ) {
    return Promise.resolve('');
  }

  if (parsedArgs.appName) {
    return Promise.resolve(parsedArgs.appName);
  }

  return enquirer
    .prompt([
      {
        name: 'AppName',
        message: `Application name                     `,
        type: 'input',
      },
    ])
    .then((a: { AppName: string }) => {
      if (!a.AppName) {
        output.error({
          title: 'Invalid name',
          bodyLines: [`Name cannot be empty`],
        });
        process.exit(1);
      }
      return a.AppName;
    });
}

async function determineFramework(
  parsedArgs: yargs.Arguments<Arguments>
): Promise<string> {
  const frameworkChoices = [
    {
      name: 'express',
      message: 'Express [https://expressjs.com/]',
    },
    {
      name: 'fastify',
      message: 'fastify [https://www.fastify.io/]',
    },
    {
      name: 'koa',
      message: 'koa     [https://koajs.com/]',
    },
  ];

  if (!parsedArgs.framework) {
    return enquirer
      .prompt([
        {
          message: 'What framework should be used?',
          type: 'autocomplete',
          name: 'framework',
          choices: frameworkChoices,
        },
      ])
      .then((a: { framework: string }) => a.framework);
  }

  const foundFramework = frameworkChoices
    .map(({ name }) => name)
    .indexOf(parsedArgs.framework);

  if (foundFramework < 0) {
    output.error({
      title: 'Invalid framework',
      bodyLines: [
        `It must be one of the following:`,
        '',
        ...frameworkChoices.map(({ name }) => name),
      ],
    });

    process.exit(1);
  }

  return Promise.resolve(parsedArgs.framework);
}

async function determineStandaloneApi(
  parsedArgs: yargs.Arguments<Arguments>
): Promise<boolean> {
  if (parsedArgs.standaloneApi === undefined) {
    return enquirer
      .prompt([
        {
          name: 'standaloneApi',
          message:
            'Would you like to use Standalone Components in your application?',
          type: 'autocomplete',
          choices: [
            {
              name: 'Yes',
            },

            {
              name: 'No',
            },
          ],
          initial: 'No' as any,
        },
      ])
      .then((a: { standaloneApi: 'Yes' | 'No' }) => a.standaloneApi === 'Yes');
  }

  return parsedArgs.standaloneApi;
}

async function determineDockerfile(
  parsedArgs: yargs.Arguments<Arguments>
): Promise<boolean> {
  if (parsedArgs.docker === undefined) {
    return enquirer
      .prompt([
        {
          name: 'docker',
          message:
            'Would you like to generate a Dockerfile? [https://docs.docker.com/]',
          type: 'autocomplete',
          choices: [
            {
              name: 'Yes',
              hint: 'I want to generate a Dockerfile',
            },
            {
              name: 'No',
            },
          ],
          initial: 'No' as any,
        },
      ])
      .then((a: { docker: 'Yes' | 'No' }) => a.docker === 'Yes');
  } else {
    return Promise.resolve(parsedArgs.docker);
  }
}

async function determineStyle(
  preset: Preset,
  parsedArgs: yargs.Arguments<Arguments>
): Promise<string> {
  if (
    preset === Preset.Apps ||
    preset === Preset.Core ||
    preset === Preset.TS ||
    preset === Preset.Empty ||
    preset === Preset.NPM ||
    preset === Preset.Nest ||
    preset === Preset.Express ||
    preset === Preset.ReactNative ||
    preset === Preset.Expo ||
    preset === Preset.NodeServer
  ) {
    return Promise.resolve(null);
  }

  const choices = [
    {
      name: 'css',
      message: 'CSS',
    },
    {
      name: 'scss',
      message: 'SASS(.scss)       [ http://sass-lang.com   ]',
    },
    {
      name: 'less',
      message: 'LESS              [ http://lesscss.org     ]',
    },
  ];

  if (![Preset.AngularMonorepo, Preset.AngularStandalone].includes(preset)) {
    choices.push({
      name: 'styl',
      message: 'Stylus(.styl)     [ http://stylus-lang.com ]',
    });
  }

  if (
    [Preset.ReactMonorepo, Preset.ReactStandalone, Preset.NextJs].includes(
      preset
    )
  ) {
    choices.push(
      {
        name: 'styled-components',
        message:
          'styled-components [ https://styled-components.com            ]',
      },
      {
        name: '@emotion/styled',
        message:
          'emotion           [ https://emotion.sh                       ]',
      },
      {
        name: 'styled-jsx',
        message:
          'styled-jsx        [ https://www.npmjs.com/package/styled-jsx ]',
      }
    );
  }

  if (!parsedArgs.style) {
    return enquirer
      .prompt([
        {
          name: 'style',
          message: `Default stylesheet format            `,
          initial: 'css' as any,
          type: 'autocomplete',
          choices: choices,
        },
      ])
      .then((a: { style: string }) => a.style);
  }

  const foundStyle = choices.find((choice) => choice.name === parsedArgs.style);

  if (foundStyle === undefined) {
    output.error({
      title: 'Invalid style',
      bodyLines: [
        `It must be one of the following:`,
        '',
        ...choices.map((choice) => choice.name),
      ],
    });

    process.exit(1);
  }

  return Promise.resolve(parsedArgs.style);
}

async function determineRouting(
  parsedArgs: yargs.Arguments<Arguments>
): Promise<boolean> {
  if (!parsedArgs.routing) {
    return enquirer
      .prompt([
        {
          name: 'routing',
          message: 'Would you like to add routing?',
          type: 'autocomplete',
          choices: [
            {
              name: 'Yes',
            },

            {
              name: 'No',
            },
          ],
          initial: 'Yes' as any,
        },
      ])
      .then((a: { routing: 'Yes' | 'No' }) => a.routing === 'Yes');
  }

  return parsedArgs.routing;
}

async function determineBundler(
  parsedArgs: yargs.Arguments<Arguments>
): Promise<'vite' | 'webpack'> {
  const choices = [
    {
      name: 'vite',
      message: 'Vite    [ https://vitejs.dev/ ]',
    },
    {
      name: 'webpack',
      message: 'Webpack [ https://webpack.js.org/ ]',
    },
  ];

  if (!parsedArgs.bundler) {
    return enquirer
      .prompt([
        {
          name: 'bundler',
          message: `Bundler to be used to build the application`,
          initial: 'vite' as any,
          type: 'autocomplete',
          choices: choices,
        },
      ])
      .then((a: { bundler: 'vite' | 'webpack' }) => a.bundler);
  }

  const foundBundler = choices.find(
    (choice) => choice.name === parsedArgs.bundler
  );

  if (foundBundler === undefined) {
    output.error({
      title: 'Invalid bundler',
      bodyLines: [
        `It must be one of the following:`,
        '',
        ...choices.map((choice) => choice.name),
      ],
    });

    process.exit(1);
  }

  return Promise.resolve(parsedArgs.bundler);
}

async function determineNxCloud(
  parsedArgs: yargs.Arguments<Arguments>
): Promise<boolean> {
  if (parsedArgs.nxCloud === undefined) {
    return enquirer
      .prompt([
        {
          name: 'NxCloud',
          message: messages.getPromptMessage('nxCloudCreation'),
          type: 'autocomplete',
          choices: [
            {
              name: 'Yes',
              hint: 'I want faster builds',
            },

            {
              name: 'No',
            },
          ],
          initial: 'Yes' as any,
        },
      ])
      .then((a: { NxCloud: 'Yes' | 'No' }) => a.NxCloud === 'Yes');
  } else {
    return parsedArgs.nxCloud;
  }
}

async function determineCI(
  parsedArgs: yargs.Arguments<Arguments>,
  nxCloud: boolean
): Promise<string> {
  if (!nxCloud) {
    if (parsedArgs.ci) {
      output.warn({
        title: 'Invalid CI value',
        bodyLines: [
          `CI option only works when Nx Cloud is enabled.`,
          `The value provided will be ignored.`,
        ],
      });
    }
    return '';
  }

  if (parsedArgs.ci) {
    return parsedArgs.ci;
  }

  if (parsedArgs.allPrompts) {
    return (
      enquirer
        .prompt([
          {
            name: 'CI',
            message: `CI workflow file to generate?      `,
            type: 'autocomplete',
            initial: '' as any,
            choices: [
              { message: 'none', name: '' },
              { message: 'GitHub Actions', name: 'github' },
              { message: 'Circle CI', name: 'circleci' },
              { message: 'Azure DevOps', name: 'azure' },
            ],
          },
        ])
        // enquirer ignores name and value if they are falsy and takes
        // first field that has a truthy value, so wee need to explicitly
        // check for none
        .then((a: { CI: string }) => (a.CI !== 'none' ? a.CI : ''))
    );
  }
  return '';
}

async function createSandbox(packageManager: PackageManager) {
  const installSpinner = ora(
    `Installing dependencies with ${packageManager}`
  ).start();

  const { install } = getPackageManagerCommand(packageManager);

  const tmpDir = dirSync().name;
  try {
    writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@nrwl/workspace': nxVersion,
          nx: nxVersion,
          typescript: tsVersion,
          prettier: prettierVersion,
        },
        license: 'MIT',
      })
    );
    generatePackageManagerFiles(tmpDir, packageManager);

    await execAndWait(install, tmpDir);

    installSpinner.succeed();
  } catch (e) {
    installSpinner.fail();
    output.error({
      title: `Nx failed to install dependencies`,
      bodyLines: mapErrorToBodyLines(e),
    });
    process.exit(1);
  } finally {
    installSpinner.stop();
  }

  return tmpDir;
}

async function createApp(
  tmpDir: string,
  name: string,
  packageManager: PackageManager,
  parsedArgs: any
): Promise<string> {
  const { _, ...restArgs } = parsedArgs;

  // Ensure to use packageManager for args
  // if it's not already passed in from previous process
  if (!restArgs.packageManager) {
    restArgs.packageManager = packageManager;
  }

  const args = unparse({
    ...restArgs,
  }).join(' ');

  const pmc = getPackageManagerCommand(packageManager);

  const command = `new ${name} ${args}`;

  const workingDir = process.cwd().replace(/\\/g, '/');
  let nxWorkspaceRoot = `"${workingDir}"`;

  // If path contains spaces there is a problem in Windows for npm@6.
  // In this case we have to escape the wrapping quotes.
  if (
    process.platform === 'win32' &&
    /\s/.test(nxWorkspaceRoot) &&
    packageManager === 'npm'
  ) {
    const pmVersion = +getPackageManagerVersion(packageManager).split('.')[0];
    if (pmVersion < 7) {
      nxWorkspaceRoot = `\\"${nxWorkspaceRoot.slice(1, -1)}\\"`;
    }
  }
  let workspaceSetupSpinner = ora(
    `Creating your workspace in ${getFileName(name)}`
  ).start();

  try {
    const fullCommand = `${pmc.exec} nx ${command} --nxWorkspaceRoot=${nxWorkspaceRoot}`;
    await execAndWait(fullCommand, tmpDir);

    workspaceSetupSpinner.succeed(
      `Nx has successfully created the workspace: ${getFileName(name)}.`
    );
  } catch (e) {
    workspaceSetupSpinner.fail();
    output.error({
      title: `Nx failed to create a workspace.`,
      bodyLines: mapErrorToBodyLines(e),
    });
    process.exit(1);
  } finally {
    workspaceSetupSpinner.stop();
  }
  return join(workingDir, getFileName(name));
}

async function createPreset(
  parsedArgs: yargs.Arguments<Arguments>,
  packageManager: PackageManager,
  directory: string
): Promise<void> {
  const { _, skipGit, ci, commit, allPrompts, nxCloud, preset, ...restArgs } =
    parsedArgs;

  const args = unparse({
    ...restArgs,
  }).join(' ');

  const pmc = getPackageManagerCommand(packageManager);

  const workingDir = process.cwd().replace(/\\/g, '/');
  let nxWorkspaceRoot = `"${workingDir}"`;

  // If path contains spaces there is a problem in Windows for npm@6.
  // In this case we have to escape the wrapping quotes.
  if (
    process.platform === 'win32' &&
    /\s/.test(nxWorkspaceRoot) &&
    packageManager === 'npm'
  ) {
    const pmVersion = +getPackageManagerVersion(packageManager).split('.')[0];
    if (pmVersion < 7) {
      nxWorkspaceRoot = `\\"${nxWorkspaceRoot.slice(1, -1)}\\"`;
    }
  }

  const command = `g ${preset}:preset ${args}`;

  try {
    const [exec, ...args] = pmc.exec.split(' ');
    args.push(
      'nx',
      `--nxWorkspaceRoot=${nxWorkspaceRoot}`,
      ...command.split(' ')
    );
    await spawnAndWait(exec, args, directory);

    output.log({
      title: `Successfully applied preset: ${preset}.`,
    });
  } catch (e) {
    output.error({
      title: `Failed to apply preset: ${preset}`,
      bodyLines: ['See above'],
    });
    process.exit(1);
  }
}

async function setupNxCloud(name: string, packageManager: PackageManager) {
  const nxCloudSpinner = ora(`Setting up NxCloud`).start();
  try {
    const pmc = getPackageManagerCommand(packageManager);
    const res = await execAndWait(
      `${pmc.exec} nx g @nrwl/nx-cloud:init --no-analytics --installationSource=create-nx-workspace`,
      path.join(process.cwd(), getFileName(name))
    );
    nxCloudSpinner.succeed('NxCloud has been set up successfully');
    return res;
  } catch (e) {
    nxCloudSpinner.fail();

    output.error({
      title: `Nx failed to setup NxCloud`,
      bodyLines: mapErrorToBodyLines(e),
    });

    process.exit(1);
  } finally {
    nxCloudSpinner.stop();
  }
}

async function setupCI(
  name: string,
  ci: string,
  packageManager: PackageManager,
  nxCloudSuccessfullyInstalled: boolean
) {
  if (!nxCloudSuccessfullyInstalled) {
    output.error({
      title: `CI workflow generation skipped`,
      bodyLines: [
        `Nx Cloud was not installed`,
        `The autogenerated CI workflow requires Nx Cloud to be set-up.`,
      ],
    });
  }
  const ciSpinner = ora(`Generating CI workflow`).start();
  try {
    const pmc = getPackageManagerCommand(packageManager);
    const res = await execAndWait(
      `${pmc.exec} nx g @nrwl/workspace:ci-workflow --ci=${ci}`,
      path.join(process.cwd(), getFileName(name))
    );
    ciSpinner.succeed('CI workflow has been generated successfully');
    return res;
  } catch (e) {
    ciSpinner.fail();

    output.error({
      title: `Nx failed to generate CI workflow`,
      bodyLines: mapErrorToBodyLines(e),
    });

    process.exit(1);
  } finally {
    ciSpinner.stop();
  }
}

function printNxCloudSuccessMessage(nxCloudOut: string) {
  const bodyLines = nxCloudOut
    .split('Distributed caching via Nx Cloud has been enabled')[1]
    .trim();
  output.note({
    title: `Distributed caching via Nx Cloud has been enabled`,
    bodyLines: bodyLines.split('\n').map((r) => r.trim()),
  });
}

function mapErrorToBodyLines(error: {
  logMessage: string;
  code: number;
  logFile: string;
}): string[] {
  if (error.logMessage?.split('\n').filter((line) => !!line).length === 1) {
    // print entire log message only if it's only a single message
    return [`Error: ${error.logMessage}`];
  }
  const lines = [`Exit code: ${error.code}`, `Log file: ${error.logFile}`];
  if (process.env.NX_VERBOSE_LOGGING) {
    lines.push(`Error: ${error.logMessage}`);
  }
  return lines;
}

function execAndWait(command: string, cwd: string) {
  return new Promise((res, rej) => {
    exec(
      command,
      { cwd, env: { ...process.env, NX_DAEMON: 'false' } },
      (error, stdout, stderr) => {
        if (error) {
          const logFile = path.join(cwd, 'error.log');
          writeFileSync(logFile, `${stdout}\n${stderr}`);
          rej({ code: error.code, logFile, logMessage: stderr });
        } else {
          res({ code: 0, stdout });
        }
      }
    );
  });
}

/**
 * Use spawn only for interactive shells
 */
function spawnAndWait(command: string, args: string[], cwd: string) {
  return new Promise((res, rej) => {
    const childProcess = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, NX_DAEMON: 'false' },
    });

    childProcess.on('exit', (code) => {
      if (code !== 0) {
        rej({ code: code });
      } else {
        res({ code: 0 });
      }
    });
  });
}

function pointToTutorialAndCourse(preset: Preset) {
  const title = `First time using Nx? Check out this interactive Nx tutorial.`;
  switch (preset) {
    case Preset.Empty:
    case Preset.NPM:
    case Preset.Apps:
    case Preset.Core:
      output.addVerticalSeparator();
      output.note({
        title,
        bodyLines: [`https://nx.dev/core-tutorial/01-create-blog`],
      });
      break;

    case Preset.TS:
      output.addVerticalSeparator();
      output.note({
        title,
        bodyLines: [`https://nx.dev/getting-started/nx-and-typescript`],
      });
      break;
    case Preset.ReactStandalone:
      output.addVerticalSeparator();
      output.note({
        title,
        bodyLines: [`https://nx.dev/getting-started/react-standalone-tutorial`],
      });
      break;
    case Preset.ReactMonorepo:
    case Preset.NextJs:
      output.addVerticalSeparator();
      output.note({
        title,
        bodyLines: [`https://nx.dev/react-tutorial/1-code-generation`],
      });
      break;
    case Preset.AngularStandalone:
      output.addVerticalSeparator();
      output.note({
        title,
        bodyLines: [
          `https://nx.dev/getting-started/angular-standalone-tutorial`,
        ],
      });
      break;
    case Preset.AngularMonorepo:
      output.addVerticalSeparator();
      output.note({
        title,
        bodyLines: [`https://nx.dev/angular-tutorial/1-code-generation`],
      });
      break;
    case Preset.Express:
    case Preset.NodeServer:
      output.addVerticalSeparator();
      output.note({
        title,
        bodyLines: [`https://nx.dev/node-tutorial/1-code-generation`],
      });
      break;
  }
}
