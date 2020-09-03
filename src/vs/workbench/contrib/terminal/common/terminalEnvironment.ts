/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'vs/base/common/path';
import * as platform from 'vs/base/common/platform';
import { URI as Uri } from 'vs/base/common/uri';
import { IWorkspaceFolder } from 'vs/platform/workspace/common/workspace';
import { IShellLaunchConfig, ITerminalEnvironment } from 'vs/workbench/contrib/terminal/common/terminal';
import { IConfigurationResolverService } from 'vs/workbench/services/configurationResolver/common/configurationResolver';
import { sanitizeProcessEnvironment } from 'vs/base/common/processes';

/**
 * This module contains utility functions related to the environment, cwd and paths.
 */

export function mergeEnvironments(parent: platform.IProcessEnvironment, other: ITerminalEnvironment | undefined): void {
	if (!other) {
		return;
	}

	// On Windows apply the new values ignoring case, while still retaining
	// the case of the original key.
	if (platform.isWindows) {
		for (const configKey in other) {
			let actualKey = configKey;
			for (const envKey in parent) {
				if (configKey.toLowerCase() === envKey.toLowerCase()) {
					actualKey = envKey;
					break;
				}
			}
			const value = other[configKey];
			_mergeEnvironmentValue(parent, actualKey, value);
		}
	} else {
		Object.keys(other).forEach((key) => {
			const value = other[key];
			_mergeEnvironmentValue(parent, key, value);
		});
	}
}

function _mergeEnvironmentValue(env: ITerminalEnvironment, key: string, value: string | null): void {
	if (typeof value === 'string') {
		env[key] = value;
	} else {
		delete env[key];
	}
}

export function addTerminalEnvironmentKeys(env: platform.IProcessEnvironment, version: string | undefined, locale: string | undefined, setLocaleVariables: boolean): void {
	env['TERM_PROGRAM'] = 'vscode';
	if (version) {
		env['TERM_PROGRAM_VERSION'] = version;
	}
	if (setLocaleVariables) {
		env['LANG'] = _getLangEnvVariable(locale);
	}
}

function mergeNonNullKeys(env: platform.IProcessEnvironment, other: ITerminalEnvironment | NodeJS.ProcessEnv | undefined) {
	if (!other) {
		return;
	}
	for (const key of Object.keys(other)) {
		const value = other[key];
		if (value) {
			env[key] = value;
		}
	}
}

function resolveConfigurationVariables(configurationResolverService: IConfigurationResolverService, env: ITerminalEnvironment, lastActiveWorkspaceRoot: IWorkspaceFolder | null): ITerminalEnvironment {
	Object.keys(env).forEach((key) => {
		const value = env[key];
		if (typeof value === 'string' && lastActiveWorkspaceRoot !== null) {
			env[key] = configurationResolverService.resolve(lastActiveWorkspaceRoot, value);
		}
	});
	return env;
}

function _getLangEnvVariable(locale?: string) {
	const parts = locale ? locale.split('-') : [];
	const n = parts.length;
	if (n === 0) {
		// Fallback to en_US to prevent possible encoding issues.
		return 'en_US.UTF-8';
	}
	if (n === 1) {
		// app.getLocale can return just a language without a variant, fill in the variant for
		// supported languages as many shells expect a 2-part locale.
		const languageVariants = {
			cs: 'CZ',
			de: 'DE',
			en: 'US',
			es: 'ES',
			fi: 'FI',
			fr: 'FR',
			hu: 'HU',
			it: 'IT',
			ja: 'JP',
			ko: 'KR',
			pl: 'PL',
			ru: 'RU',
			zh: 'CN'
		};
		if (parts[0] in languageVariants) {
			parts.push(languageVariants[parts[0]]);
		}
	} else {
		// Ensure the variant is uppercase
		parts[1] = parts[1].toUpperCase();
	}
	return parts.join('_') + '.UTF-8';
}

export function getCwd(shell: IShellLaunchConfig, userHome: string, root?: Uri, customCwd?: string): string {
	if (shell.cwd) {
		return (typeof shell.cwd === 'object') ? shell.cwd.fsPath : shell.cwd;
	}

	let cwd: string | undefined;

	// TODO: Handle non-existent customCwd
	if (!shell.ignoreConfigurationCwd && customCwd) {
		if (path.isAbsolute(customCwd)) {
			cwd = customCwd;
		} else if (root) {
			cwd = path.join(root.fsPath, customCwd);
		}
	}

	// If there was no custom cwd or it was relative with no workspace
	if (!cwd) {
		cwd = root ? root.fsPath : userHome;
	}

	return _sanitizeCwd(cwd);
}

function _sanitizeCwd(cwd: string): string {
	// Make the drive letter uppercase on Windows (see #9448)
	if (platform.platform === platform.Platform.Windows && cwd && cwd[1] === ':') {
		return cwd[0].toUpperCase() + cwd.substr(1);
	}
	return cwd;
}

export function escapeNonWindowsPath(path: string): string {
	let newPath = path;
	if (newPath.indexOf('\\') !== 0) {
		newPath = newPath.replace(/\\/g, '\\\\');
	}
	if (!newPath && (newPath.indexOf('"') !== -1)) {
		newPath = '\'' + newPath + '\'';
	} else if (newPath.indexOf(' ') !== -1) {
		newPath = newPath.replace(/ /g, '\\ ');
	}
	return newPath;
}

export function getDefaultShell(
	fetchSetting: (key: string) => { user: string | string[] | undefined, value: string | string[] | undefined, default: string | string[] | undefined },
	isWorkspaceShellAllowed: boolean,
	defaultShell: string,
	isWoW64: boolean,
	windir: string | undefined,
	platformOverride: platform.Platform = platform.platform
): string {
	const platformKey = platformOverride === platform.Platform.Windows ? 'windows' : platformOverride === platform.Platform.Mac ? 'osx' : 'linux';
	const shellConfigValue = fetchSetting(`terminal.integrated.shell.${platformKey}`);
	let executable = (isWorkspaceShellAllowed ? <string>shellConfigValue.value : <string>shellConfigValue.user) || (<string | null>shellConfigValue.default || defaultShell);

	// Change Sysnative to System32 if the OS is Windows but NOT WoW64. It's
	// safe to assume that this was used by accident as Sysnative does not
	// exist and will break the terminal in non-WoW64 environments.
	if ((platformOverride === platform.Platform.Windows) && !isWoW64 && windir) {
		const sysnativePath = path.join(windir, 'Sysnative').toLowerCase();
		if (executable && executable.toLowerCase().indexOf(sysnativePath) === 0) {
			executable = path.join(windir, 'System32', executable.substr(sysnativePath.length));
		}
	}

	// Convert / to \ on Windows for convenience
	if (executable && platformOverride === platform.Platform.Windows) {
		executable = executable.replace(/\//g, '\\');
	}

	return executable;
}

export function getDefaultShellArgs(
	fetchSetting: (key: string) => { user: string | string[] | undefined, value: string | string[] | undefined, default: string | string[] | undefined },
	isWorkspaceShellAllowed: boolean,
	platformOverride: platform.Platform = platform.platform
): string[] {
	const platformKey = platformOverride === platform.Platform.Windows ? 'windows' : platformOverride === platform.Platform.Mac ? 'osx' : 'linux';
	const shellArgsConfigValue = fetchSetting(`terminal.integrated.shellArgs.${platformKey}`);
	const args = (isWorkspaceShellAllowed ? <string[]>shellArgsConfigValue.value : <string[]>shellArgsConfigValue.user) || <string[]>shellArgsConfigValue.default;
	return args;
}

export function createTerminalEnvironment(
	shellLaunchConfig: IShellLaunchConfig,
	lastActiveWorkspace: IWorkspaceFolder | null,
	envFromConfig: { user: ITerminalEnvironment | undefined, value: ITerminalEnvironment | undefined, default: ITerminalEnvironment | undefined },
	configurationResolverService: IConfigurationResolverService | undefined,
	isWorkspaceShellAllowed: boolean,
	version: string | undefined,
	setLocaleVariables: boolean,
	baseEnv: platform.IProcessEnvironment
): platform.IProcessEnvironment {
	// Create a terminal environment based on settings, launch config and permissions
	let env: platform.IProcessEnvironment = {};
	if (shellLaunchConfig.strictEnv) {
		// strictEnv is true, only use the requested env (ignoring null entries)
		mergeNonNullKeys(env, shellLaunchConfig.env);
	} else {
		// Merge process env with the env from config and from shellLaunchConfig
		mergeNonNullKeys(env, baseEnv);

		// const platformKey = platform.isWindows ? 'windows' : (platform.isMacintosh ? 'osx' : 'linux');
		// const envFromConfigValue = this._workspaceConfigurationService.inspect<ITerminalEnvironment | undefined>(`terminal.integrated.env.${platformKey}`);
		const allowedEnvFromConfig = { ...(isWorkspaceShellAllowed ? envFromConfig.value : envFromConfig.user) };

		// Resolve env vars from config and shell
		if (configurationResolverService) {
			if (allowedEnvFromConfig) {
				resolveConfigurationVariables(configurationResolverService, allowedEnvFromConfig, lastActiveWorkspace);
			}
			if (shellLaunchConfig.env) {
				resolveConfigurationVariables(configurationResolverService, shellLaunchConfig.env, lastActiveWorkspace);
			}
		}

		// Merge config (settings) and ShellLaunchConfig environments
		mergeEnvironments(env, allowedEnvFromConfig);
		mergeEnvironments(env, shellLaunchConfig.env);

		// Sanitize the environment, removing any undesirable VS Code and Electron environment
		// variables
		sanitizeProcessEnvironment(env, 'VSCODE_IPC_HOOK_CLI');

		// Adding other env keys necessary to create the process
		addTerminalEnvironmentKeys(env, version, platform.locale, setLocaleVariables);
	}
	return env;
}
