/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { Event, Emitter } from 'vs/base/common/event';
import { IInstantiationService, ServiceIdentifier } from 'vs/platform/instantiation/common/instantiation';
import { IExtensionHostProfile, ProfileSession, IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { Disposable, IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { onUnexpectedError } from 'vs/base/common/errors';
import { StatusbarAlignment, IStatusbarService, IStatusbarEntryAccessor, IStatusbarEntry } from 'vs/platform/statusbar/common/statusbar';
import { IExtensionHostProfileService, ProfileSessionState } from 'vs/workbench/contrib/extensions/electron-browser/runtimeExtensionsEditor';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IWindowsService } from 'vs/platform/windows/common/windows';
import { IDialogService } from 'vs/platform/dialogs/common/dialogs';
import { randomPort } from 'vs/base/node/ports';
import product from 'vs/platform/product/node/product';
import { RuntimeExtensionsInput } from 'vs/workbench/contrib/extensions/electron-browser/runtimeExtensionsInput';
import { ExtensionIdentifier } from 'vs/platform/extensions/common/extensions';
import { ExtensionHostProfiler } from 'vs/workbench/services/extensions/electron-browser/extensionHostProfiler';
import { CommandsRegistry } from 'vs/platform/commands/common/commands';

export class ExtensionHostProfileService extends Disposable implements IExtensionHostProfileService {

	_serviceBrand: ServiceIdentifier<IExtensionHostProfileService>;

	private readonly _onDidChangeState: Emitter<void> = this._register(new Emitter<void>());
	public readonly onDidChangeState: Event<void> = this._onDidChangeState.event;

	private readonly _onDidChangeLastProfile: Emitter<void> = this._register(new Emitter<void>());
	public readonly onDidChangeLastProfile: Event<void> = this._onDidChangeLastProfile.event;

	private readonly _unresponsiveProfiles = new Map<string, IExtensionHostProfile>();
	private _profile: IExtensionHostProfile | null;
	private _profileSession: ProfileSession | null;
	private _state: ProfileSessionState;

	private profilingStatusBarIndicator: IStatusbarEntryAccessor | undefined;
	private profilingStatusBarIndicatorLabelUpdater: IDisposable | undefined;

	public get state() { return this._state; }
	public get lastProfile() { return this._profile; }

	constructor(
		@IExtensionService private readonly _extensionService: IExtensionService,
		@IEditorService private readonly _editorService: IEditorService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IWindowsService private readonly _windowsService: IWindowsService,
		@IDialogService private readonly _dialogService: IDialogService,
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
	) {
		super();
		this._profile = null;
		this._profileSession = null;
		this._setState(ProfileSessionState.None);

		CommandsRegistry.registerCommand('workbench.action.extensionHostProfilder.stop', () => {
			this.stopProfiling();
			this._editorService.openEditor(this._instantiationService.createInstance(RuntimeExtensionsInput), { revealIfOpened: true });
		});
	}

	private _setState(state: ProfileSessionState): void {
		if (this._state === state) {
			return;
		}
		this._state = state;

		if (this._state === ProfileSessionState.Running) {
			this.updateProfilingStatusBarIndicator(true);
		} else if (this._state === ProfileSessionState.Stopping) {
			this.updateProfilingStatusBarIndicator(false);
		}

		this._onDidChangeState.fire(undefined);
	}

	private updateProfilingStatusBarIndicator(visible: boolean): void {
		if (this.profilingStatusBarIndicatorLabelUpdater) {
			this.profilingStatusBarIndicatorLabelUpdater.dispose();
			this.profilingStatusBarIndicatorLabelUpdater = undefined;
		}

		if (visible) {
			const indicator: IStatusbarEntry = {
				text: nls.localize('profilingExtensionHost', "$(sync~spin) Profiling Extension Host"),
				tooltip: nls.localize('selectAndStartDebug', "Click to stop profiling."),
				command: 'workbench.action.extensionHostProfilder.stop'
			};

			const timeStarted = Date.now();
			const handle = setInterval(() => {
				if (this.profilingStatusBarIndicator) {
					this.profilingStatusBarIndicator.update({ ...indicator, text: nls.localize('profilingExtensionHostTime', "$(sync~spin) Profiling Extension Host ({0} sec)", Math.round((new Date().getTime() - timeStarted) / 1000)), });
				}
			}, 1000);
			this.profilingStatusBarIndicatorLabelUpdater = toDisposable(() => clearInterval(handle));

			if (!this.profilingStatusBarIndicator) {
				this.profilingStatusBarIndicator = this._statusbarService.addEntry(indicator, 'status.profiler', nls.localize('status.profiler', "Extension Profiler"), StatusbarAlignment.RIGHT);
			} else {
				this.profilingStatusBarIndicator.update(indicator);
			}
		} else {
			if (this.profilingStatusBarIndicator) {
				this.profilingStatusBarIndicator.dispose();
				this.profilingStatusBarIndicator = undefined;
			}
		}
	}

	public startProfiling(): Promise<any> | null {
		if (this._state !== ProfileSessionState.None) {
			return null;
		}

		const inspectPort = this._extensionService.getInspectPort();
		if (!inspectPort) {
			return this._dialogService.confirm({
				type: 'info',
				message: nls.localize('restart1', "Profile Extensions"),
				detail: nls.localize('restart2', "In order to profile extensions a restart is required. Do you want to restart '{0}' now?", product.nameLong),
				primaryButton: nls.localize('restart3', "Restart"),
				secondaryButton: nls.localize('cancel', "Cancel")
			}).then(res => {
				if (res.confirmed) {
					this._windowsService.relaunch({ addArgs: [`--inspect-extensions=${randomPort()}`] });
				}
			});
		}

		this._setState(ProfileSessionState.Starting);

		return this._instantiationService.createInstance(ExtensionHostProfiler, inspectPort).start().then((value) => {
			this._profileSession = value;
			this._setState(ProfileSessionState.Running);
		}, (err) => {
			onUnexpectedError(err);
			this._setState(ProfileSessionState.None);
		});
	}

	public stopProfiling(): void {
		if (this._state !== ProfileSessionState.Running || !this._profileSession) {
			return;
		}

		this._setState(ProfileSessionState.Stopping);
		this._profileSession.stop().then((result) => {
			this._setLastProfile(result);
			this._setState(ProfileSessionState.None);
		}, (err) => {
			onUnexpectedError(err);
			this._setState(ProfileSessionState.None);
		});
		this._profileSession = null;
	}

	private _setLastProfile(profile: IExtensionHostProfile) {
		this._profile = profile;
		this._onDidChangeLastProfile.fire(undefined);
	}

	getUnresponsiveProfile(extensionId: ExtensionIdentifier): IExtensionHostProfile | undefined {
		return this._unresponsiveProfiles.get(ExtensionIdentifier.toKey(extensionId));
	}

	setUnresponsiveProfile(extensionId: ExtensionIdentifier, profile: IExtensionHostProfile): void {
		this._unresponsiveProfiles.set(ExtensionIdentifier.toKey(extensionId), profile);
		this._setLastProfile(profile);
	}

}
