/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ITerminalInstanceService } from 'vs/workbench/contrib/terminal/browser/terminal';
import { ITerminalInstance, IWindowsShellHelper, IShellLaunchConfig, ITerminalChildProcess, IS_WORKSPACE_SHELL_ALLOWED_STORAGE_KEY } from 'vs/workbench/contrib/terminal/common/terminal';
import { WindowsShellHelper } from 'vs/workbench/contrib/terminal/node/windowsShellHelper';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IProcessEnvironment, platform, Platform } from 'vs/base/common/platform';
import { TerminalProcess } from 'vs/workbench/contrib/terminal/node/terminalProcess';
import { getSystemShell } from 'vs/workbench/contrib/terminal/node/terminal';
import { Terminal as XTermTerminal } from 'xterm';
import { WebLinksAddon as XTermWebLinksAddon } from 'xterm-addon-web-links';
import { SearchAddon as XTermSearchAddon } from 'xterm-addon-search';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { getDefaultShell, getDefaultShellArgs } from 'vs/workbench/contrib/terminal/common/terminalEnvironment';
import { StorageScope, IStorageService } from 'vs/platform/storage/common/storage';
import { getMainProcessParentEnv } from 'vs/workbench/contrib/terminal/node/terminalEnvironment';

let Terminal: typeof XTermTerminal;
let WebLinksAddon: typeof XTermWebLinksAddon;
let SearchAddon: typeof XTermSearchAddon;

export class TerminalInstanceService implements ITerminalInstanceService {
	public _serviceBrand: any;

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IStorageService private readonly _storageService: IStorageService
	) {
	}

	public async getXtermConstructor(): Promise<typeof XTermTerminal> {
		if (!Terminal) {
			Terminal = (await import('xterm')).Terminal;
		}
		return Terminal;
	}

	public async getXtermWebLinksConstructor(): Promise<typeof XTermWebLinksAddon> {
		if (!WebLinksAddon) {
			WebLinksAddon = (await import('xterm-addon-web-links')).WebLinksAddon;
		}
		return WebLinksAddon;
	}

	public async getXtermSearchConstructor(): Promise<typeof XTermSearchAddon> {
		if (!SearchAddon) {
			SearchAddon = (await import('xterm-addon-search')).SearchAddon;
		}
		return SearchAddon;
	}

	public createWindowsShellHelper(shellProcessId: number, instance: ITerminalInstance, xterm: XTermTerminal): IWindowsShellHelper {
		return new WindowsShellHelper(shellProcessId, instance, xterm);
	}

	public createTerminalProcess(shellLaunchConfig: IShellLaunchConfig, cwd: string, cols: number, rows: number, env: IProcessEnvironment, windowsEnableConpty: boolean): ITerminalChildProcess {
		return this._instantiationService.createInstance(TerminalProcess, shellLaunchConfig, cwd, cols, rows, env, windowsEnableConpty);
	}

	private _isWorkspaceShellAllowed(): boolean {
		return this._storageService.getBoolean(IS_WORKSPACE_SHELL_ALLOWED_STORAGE_KEY, StorageScope.WORKSPACE, false);
	}

	public getDefaultShellAndArgs(platformOverride: Platform = platform): Promise<{ shell: string, args: string[] | undefined }> {
		const isWorkspaceShellAllowed = this._isWorkspaceShellAllowed();
		const shell = getDefaultShell(
			(key) => this._configurationService.inspect(key),
			isWorkspaceShellAllowed,
			getSystemShell(platformOverride),
			process.env.hasOwnProperty('PROCESSOR_ARCHITEW6432'),
			process.env.windir,
			platformOverride
		);
		const args = getDefaultShellArgs(
			(key) => this._configurationService.inspect(key),
			isWorkspaceShellAllowed,
			platformOverride
		);
		return Promise.resolve({ shell, args });
	}

	public getMainProcessParentEnv(): Promise<IProcessEnvironment> {
		return getMainProcessParentEnv();
	}
}