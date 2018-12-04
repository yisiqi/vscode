/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import * as path from 'path';
import { isNonEmptyArray } from 'vs/base/common/arrays';
import { Barrier, runWhenIdle } from 'vs/base/common/async';
import { Emitter, Event } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import * as perf from 'vs/base/common/performance';
import { isEqualOrParent } from 'vs/base/common/resources';
import { URI } from 'vs/base/common/uri';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { EnablementState, IExtensionEnablementService, IExtensionIdentifier, IExtensionManagementService, LocalExtensionType } from 'vs/platform/extensionManagement/common/extensionManagement';
import { BetterMergeId, areSameExtensions, getGalleryExtensionIdFromLocal } from 'vs/platform/extensionManagement/common/extensionManagementUtil';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ILifecycleService, LifecyclePhase } from 'vs/platform/lifecycle/common/lifecycle';
import pkg from 'vs/platform/node/package';
import product from 'vs/platform/node/product';
import { INotificationService, Severity } from 'vs/platform/notification/common/notification';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IWindowService, IWindowsService } from 'vs/platform/windows/common/windows';
import { ActivationTimes, ExtensionPointContribution, IExtensionDescription, IExtensionService, IExtensionsStatus, IMessage, ProfileSession, IWillActivateEvent, IResponsiveStateChangeEvent } from 'vs/workbench/services/extensions/common/extensions';
import { ExtensionMessageCollector, ExtensionPoint, ExtensionsRegistry, IExtensionPoint, IExtensionPointUser, schema } from 'vs/workbench/services/extensions/common/extensionsRegistry';
import { ExtensionHostProcessWorker } from 'vs/workbench/services/extensions/electron-browser/extensionHost';
import { ExtensionDescriptionRegistry } from 'vs/workbench/services/extensions/node/extensionDescriptionRegistry';
import { ResponsiveState } from 'vs/workbench/services/extensions/node/rpcProtocol';
import { CachedExtensionScanner, Logger } from 'vs/workbench/services/extensions/electron-browser/cachedExtensionScanner';
import { ExtensionHostProcessManager } from 'vs/workbench/services/extensions/electron-browser/extensionHostProcessManager';

const hasOwnProperty = Object.hasOwnProperty;
const NO_OP_VOID_PROMISE = Promise.resolve<void>(void 0);

schema.properties.engines.properties.vscode.default = `^${pkg.version}`;

export class ExtensionService extends Disposable implements IExtensionService {

	public _serviceBrand: any;

	private readonly _extensionHostLogsLocation: URI;
	private _registry: ExtensionDescriptionRegistry;
	private readonly _installedExtensionsReady: Barrier;
	private readonly _isDev: boolean;
	private readonly _extensionsMessages: { [id: string]: IMessage[] };
	private _allRequestedActivateEvents: { [activationEvent: string]: boolean; };
	private readonly _extensionScanner: CachedExtensionScanner;

	private readonly _onDidRegisterExtensions: Emitter<void> = this._register(new Emitter<void>({ leakWarningThreshold: 500 }));
	public readonly onDidRegisterExtensions = this._onDidRegisterExtensions.event;

	private readonly _onDidChangeExtensionsStatus: Emitter<string[]> = this._register(new Emitter<string[]>());
	public readonly onDidChangeExtensionsStatus: Event<string[]> = this._onDidChangeExtensionsStatus.event;

	private readonly _onWillActivateByEvent = this._register(new Emitter<IWillActivateEvent>());
	public readonly onWillActivateByEvent: Event<IWillActivateEvent> = this._onWillActivateByEvent.event;

	private readonly _onDidChangeResponsiveChange = this._register(new Emitter<IResponsiveStateChangeEvent>());
	public readonly onDidChangeResponsiveChange: Event<IResponsiveStateChangeEvent> = this._onDidChangeResponsiveChange.event;

	// --- Members used per extension host process
	private _extensionHostProcessManagers: ExtensionHostProcessManager[];
	private _extensionHostProcessActivationTimes: { [id: string]: ActivationTimes; };
	private _extensionHostExtensionRuntimeErrors: { [id: string]: Error[]; };

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IExtensionEnablementService private readonly _extensionEnablementService: IExtensionEnablementService,
		@IWindowService private readonly _windowService: IWindowService,
		@ILifecycleService private readonly _lifecycleService: ILifecycleService,
		@IExtensionManagementService private readonly _extensionManagementService: IExtensionManagementService
	) {
		super();
		this._extensionHostLogsLocation = URI.file(path.posix.join(this._environmentService.logsPath, `exthost${this._windowService.getCurrentWindowId()}`));
		this._registry = null;
		this._installedExtensionsReady = new Barrier();
		this._isDev = !this._environmentService.isBuilt || this._environmentService.isExtensionDevelopment;
		this._extensionsMessages = {};
		this._allRequestedActivateEvents = Object.create(null);
		this._extensionScanner = this._instantiationService.createInstance(CachedExtensionScanner);

		this._extensionHostProcessManagers = [];
		this._extensionHostProcessActivationTimes = Object.create(null);
		this._extensionHostExtensionRuntimeErrors = Object.create(null);

		this._startDelayed(this._lifecycleService);

		if (this._extensionEnablementService.allUserExtensionsDisabled) {
			this._notificationService.prompt(Severity.Info, nls.localize('extensionsDisabled', "All installed extensions are temporarily disabled. Reload the window to return to the previous state."), [{
				label: nls.localize('Reload', "Reload"),
				run: () => {
					this._windowService.reloadWindow();
				}
			}]);
		}
	}

	private _startDelayed(lifecycleService: ILifecycleService): void {
		// delay extension host creation and extension scanning
		// until the workbench is running. we cannot defer the
		// extension host more (LifecyclePhase.Restored) because
		// some editors require the extension host to restore
		// and this would result in a deadlock
		// see https://github.com/Microsoft/vscode/issues/41322
		lifecycleService.when(LifecyclePhase.Ready).then(() => {
			// reschedule to ensure this runs after restoring viewlets, panels, and editors
			runWhenIdle(() => {
				perf.mark('willLoadExtensions');
				this._startExtensionHostProcess(true, []);
				this._scanAndHandleExtensions();
				this.whenInstalledExtensionsRegistered().then(() => perf.mark('didLoadExtensions'));
			}, 50 /*max delay*/);
		});
	}

	public dispose(): void {
		super.dispose();
		this._onWillActivateByEvent.dispose();
		this._onDidChangeResponsiveChange.dispose();
	}

	public restartExtensionHost(): void {
		this._stopExtensionHostProcess();
		this._startExtensionHostProcess(false, Object.keys(this._allRequestedActivateEvents));
	}

	public startExtensionHost(): void {
		this._startExtensionHostProcess(false, Object.keys(this._allRequestedActivateEvents));
	}

	public stopExtensionHost(): void {
		this._stopExtensionHostProcess();
	}

	private _stopExtensionHostProcess(): void {
		const previouslyActivatedExtensionIds = Object.keys(this._extensionHostProcessActivationTimes);

		for (let i = 0; i < this._extensionHostProcessManagers.length; i++) {
			this._extensionHostProcessManagers[i].dispose();
		}
		this._extensionHostProcessManagers = [];
		this._extensionHostProcessActivationTimes = Object.create(null);
		this._extensionHostExtensionRuntimeErrors = Object.create(null);

		if (previouslyActivatedExtensionIds.length > 0) {
			this._onDidChangeExtensionsStatus.fire(previouslyActivatedExtensionIds);
		}
	}

	private _startExtensionHostProcess(isInitialStart: boolean, initialActivationEvents: string[]): void {
		this._stopExtensionHostProcess();

		const extHostProcessWorker = this._instantiationService.createInstance(ExtensionHostProcessWorker, !isInitialStart, this.getExtensions(), this._extensionHostLogsLocation);
		const extHostProcessManager = this._instantiationService.createInstance(ExtensionHostProcessManager, extHostProcessWorker, null, initialActivationEvents);
		extHostProcessManager.onDidCrash(([code, signal]) => this._onExtensionHostCrashed(code, signal));
		extHostProcessManager.onDidChangeResponsiveState((responsiveState) => { this._onDidChangeResponsiveChange.fire({ target: extHostProcessManager, isResponsive: responsiveState === ResponsiveState.Responsive }); });
		this._extensionHostProcessManagers.push(extHostProcessManager);
	}

	private _onExtensionHostCrashed(code: number, signal: string): void {
		console.error('Extension host terminated unexpectedly. Code: ', code, ' Signal: ', signal);
		this._stopExtensionHostProcess();

		if (code === 55) {
			this._notificationService.prompt(
				Severity.Error,
				nls.localize('extensionHostProcess.versionMismatchCrash', "Extension host cannot start: version mismatch."),
				[{
					label: nls.localize('relaunch', "Relaunch VS Code"),
					run: () => {
						this._instantiationService.invokeFunction((accessor) => {
							const windowsService = accessor.get(IWindowsService);
							windowsService.relaunch({});
						});
					}
				}]
			);
			return;
		}

		let message = nls.localize('extensionHostProcess.crash', "Extension host terminated unexpectedly.");
		if (code === 87) {
			message = nls.localize('extensionHostProcess.unresponsiveCrash', "Extension host terminated because it was not responsive.");
		}

		this._notificationService.prompt(Severity.Error, message,
			[{
				label: nls.localize('devTools', "Open Developer Tools"),
				run: () => this._windowService.openDevTools()
			},
			{
				label: nls.localize('restart', "Restart Extension Host"),
				run: () => this._startExtensionHostProcess(false, Object.keys(this._allRequestedActivateEvents))
			}]
		);
	}

	// ---- begin IExtensionService

	public activateByEvent(activationEvent: string): Promise<void> {
		if (this._installedExtensionsReady.isOpen()) {
			// Extensions have been scanned and interpreted

			if (!this._registry.containsActivationEvent(activationEvent)) {
				// There is no extension that is interested in this activation event
				return NO_OP_VOID_PROMISE;
			}

			// Record the fact that this activationEvent was requested (in case of a restart)
			this._allRequestedActivateEvents[activationEvent] = true;

			return this._activateByEvent(activationEvent);
		} else {
			// Extensions have not been scanned yet.

			// Record the fact that this activationEvent was requested (in case of a restart)
			this._allRequestedActivateEvents[activationEvent] = true;

			return this._installedExtensionsReady.wait().then(() => this._activateByEvent(activationEvent));
		}
	}

	private _activateByEvent(activationEvent: string): Promise<void> {
		const result = Promise.all(
			this._extensionHostProcessManagers.map(extHostManager => extHostManager.activateByEvent(activationEvent))
		).then(() => { });
		this._onWillActivateByEvent.fire({
			event: activationEvent,
			activation: result
		});
		return result;
	}

	public whenInstalledExtensionsRegistered(): Promise<boolean> {
		return this._installedExtensionsReady.wait();
	}

	public getExtensions(): Promise<IExtensionDescription[]> {
		return this._installedExtensionsReady.wait().then(() => {
			return this._registry.getAllExtensionDescriptions();
		});
	}

	public getExtension(id: string): Promise<IExtensionDescription | undefined> {
		return this._installedExtensionsReady.wait().then(() => {
			return this._registry.getExtensionDescription(id);
		});
	}

	public readExtensionPointContributions<T>(extPoint: IExtensionPoint<T>): Promise<ExtensionPointContribution<T>[]> {
		return this._installedExtensionsReady.wait().then(() => {
			let availableExtensions = this._registry.getAllExtensionDescriptions();

			let result: ExtensionPointContribution<T>[] = [], resultLen = 0;
			for (let i = 0, len = availableExtensions.length; i < len; i++) {
				let desc = availableExtensions[i];

				if (desc.contributes && hasOwnProperty.call(desc.contributes, extPoint.name)) {
					result[resultLen++] = new ExtensionPointContribution<T>(desc, desc.contributes[extPoint.name]);
				}
			}

			return result;
		});
	}

	public getExtensionsStatus(): { [id: string]: IExtensionsStatus; } {
		let result: { [id: string]: IExtensionsStatus; } = Object.create(null);
		if (this._registry) {
			const extensions = this._registry.getAllExtensionDescriptions();
			for (let i = 0, len = extensions.length; i < len; i++) {
				const extension = extensions[i];
				const id = extension.id;
				result[id] = {
					messages: this._extensionsMessages[id],
					activationTimes: this._extensionHostProcessActivationTimes[id],
					runtimeErrors: this._extensionHostExtensionRuntimeErrors[id],
				};
			}
		}
		return result;
	}

	public canProfileExtensionHost(): boolean {
		for (let i = 0, len = this._extensionHostProcessManagers.length; i < len; i++) {
			const extHostProcessManager = this._extensionHostProcessManagers[i];
			if (extHostProcessManager.canProfileExtensionHost()) {
				return true;
			}
		}
		return false;
	}

	public startExtensionHostProfile(): Promise<ProfileSession> {
		for (let i = 0, len = this._extensionHostProcessManagers.length; i < len; i++) {
			const extHostProcessManager = this._extensionHostProcessManagers[i];
			if (extHostProcessManager.canProfileExtensionHost()) {
				return extHostProcessManager.startExtensionHostProfile();
			}
		}
		throw new Error('Extension host not running or no inspect port available');
	}

	public getInspectPort(): number {
		if (this._extensionHostProcessManagers.length > 0) {
			return this._extensionHostProcessManagers[0].getInspectPort();
		}
		return 0;
	}

	// ---- end IExtensionService

	// --- impl

	private async _scanAndHandleExtensions(): Promise<void> {
		this._extensionScanner.startScanningExtensions(new Logger((severity, source, message) => {
			if (this._isDev && source) {
				this._logOrShowMessage(severity, `[${source}]: ${message}`);
			} else {
				this._logOrShowMessage(severity, message);
			}
		}));

		const extensionHost = this._extensionHostProcessManagers[0];
		const extensions = await this._extensionScanner.scannedExtensions;
		const enabledExtensions = await this._getRuntimeExtensions(extensions);
		extensionHost.start(enabledExtensions.map(extension => extension.id));
		this._onHasExtensions(enabledExtensions);
	}

	private _onHasExtensions(allExtensions: IExtensionDescription[]): void {
		this._registry = new ExtensionDescriptionRegistry(allExtensions);

		let availableExtensions = this._registry.getAllExtensionDescriptions();
		let extensionPoints = ExtensionsRegistry.getExtensionPoints();

		let messageHandler = (msg: IMessage) => this._handleExtensionPointMessage(msg);

		for (let i = 0, len = extensionPoints.length; i < len; i++) {
			ExtensionService._handleExtensionPoint(extensionPoints[i], availableExtensions, messageHandler);
		}

		perf.mark('extensionHostReady');
		this._installedExtensionsReady.open();
		this._onDidRegisterExtensions.fire(void 0);
		this._onDidChangeExtensionsStatus.fire(availableExtensions.map(e => e.id));
	}

	private _getRuntimeExtensions(allExtensions: IExtensionDescription[]): Promise<IExtensionDescription[]> {
		return this._extensionEnablementService.getDisabledExtensions()
			.then(disabledExtensions => {

				const result: { [extensionId: string]: IExtensionDescription; } = {};
				const extensionsToDisable: IExtensionIdentifier[] = [];
				const userMigratedSystemExtensions: IExtensionIdentifier[] = [{ id: BetterMergeId }];

				const enableProposedApiFor: string | string[] = this._environmentService.args['enable-proposed-api'] || [];

				const notFound = (id: string) => nls.localize('notFound', "Extension \`{0}\` cannot use PROPOSED API as it cannot be found", id);

				if (enableProposedApiFor.length) {
					let allProposed = (enableProposedApiFor instanceof Array ? enableProposedApiFor : [enableProposedApiFor]);
					allProposed.forEach(id => {
						if (!allExtensions.some(description => description.id === id)) {
							console.error(notFound(id));
						}
					});
				}

				const enableProposedApiForAll = !this._environmentService.isBuilt ||
					(!!this._environmentService.extensionDevelopmentLocationURI && product.nameLong.indexOf('Insiders') >= 0) ||
					(enableProposedApiFor.length === 0 && 'enable-proposed-api' in this._environmentService.args);

				for (const extension of allExtensions) {
					const isExtensionUnderDevelopment = this._environmentService.isExtensionDevelopment && isEqualOrParent(extension.extensionLocation, this._environmentService.extensionDevelopmentLocationURI);
					// Do not disable extensions under development
					if (!isExtensionUnderDevelopment) {
						if (disabledExtensions.some(disabled => areSameExtensions(disabled, extension))) {
							continue;
						}
					}

					if (!extension.isBuiltin) {
						// Check if the extension is changed to system extension
						const userMigratedSystemExtension = userMigratedSystemExtensions.filter(userMigratedSystemExtension => areSameExtensions(userMigratedSystemExtension, { id: extension.id }))[0];
						if (userMigratedSystemExtension) {
							extensionsToDisable.push(userMigratedSystemExtension);
							continue;
						}
					}
					result[extension.id] = this._updateEnableProposedApi(extension, enableProposedApiForAll, enableProposedApiFor);
				}
				const runtimeExtensions = Object.keys(result).map(name => result[name]);

				this._telemetryService.publicLog('extensionsScanned', {
					totalCount: runtimeExtensions.length,
					disabledCount: disabledExtensions.length
				});

				if (extensionsToDisable.length) {
					return this._extensionManagementService.getInstalled(LocalExtensionType.User)
						.then(installed => {
							const toDisable = installed.filter(i => extensionsToDisable.some(e => areSameExtensions({ id: getGalleryExtensionIdFromLocal(i) }, e)));
							return Promise.all(toDisable.map(e => this._extensionEnablementService.setEnablement(e, EnablementState.Disabled)));
						})
						.then(() => {
							return runtimeExtensions;
						});
				} else {
					return runtimeExtensions;
				}
			});
	}

	private _updateEnableProposedApi(extension: IExtensionDescription, enableProposedApiForAll: boolean, enableProposedApiFor: string | string[]): IExtensionDescription {
		if (isNonEmptyArray(product.extensionAllowedProposedApi)
			&& product.extensionAllowedProposedApi.indexOf(extension.id) >= 0
		) {
			// fast lane -> proposed api is available to all extensions
			// that are listed in product.json-files
			extension.enableProposedApi = true;

		} else if (extension.enableProposedApi && !extension.isBuiltin) {
			if (
				!enableProposedApiForAll &&
				enableProposedApiFor.indexOf(extension.id) < 0
			) {
				extension.enableProposedApi = false;
				console.error(`Extension '${extension.id} cannot use PROPOSED API (must started out of dev or enabled via --enable-proposed-api)`);

			} else {
				// proposed api is available when developing or when an extension was explicitly
				// spelled out via a command line argument
				console.warn(`Extension '${extension.id}' uses PROPOSED API which is subject to change and removal without notice.`);
			}
		}
		return extension;
	}

	private _handleExtensionPointMessage(msg: IMessage) {

		if (!this._extensionsMessages[msg.extensionId]) {
			this._extensionsMessages[msg.extensionId] = [];
		}
		this._extensionsMessages[msg.extensionId].push(msg);

		const extension = this._registry.getExtensionDescription(msg.extensionId);
		const strMsg = `[${msg.extensionId}]: ${msg.message}`;
		if (extension && extension.isUnderDevelopment) {
			// This message is about the extension currently being developed
			this._showMessageToUser(msg.type, strMsg);
		} else {
			this._logMessageInConsole(msg.type, strMsg);
		}

		if (!this._isDev && msg.extensionId) {
			const { type, extensionId, extensionPointId, message } = msg;
			/* __GDPR__
				"extensionsMessage" : {
					"type" : { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true },
					"extensionId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" },
					"extensionPointId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" },
					"message": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" }
				}
			*/
			this._telemetryService.publicLog('extensionsMessage', {
				type, extensionId, extensionPointId, message
			});
		}
	}

	private static _handleExtensionPoint<T>(extensionPoint: ExtensionPoint<T>, availableExtensions: IExtensionDescription[], messageHandler: (msg: IMessage) => void): void {
		let users: IExtensionPointUser<T>[] = [], usersLen = 0;
		for (let i = 0, len = availableExtensions.length; i < len; i++) {
			let desc = availableExtensions[i];

			if (desc.contributes && hasOwnProperty.call(desc.contributes, extensionPoint.name)) {
				users[usersLen++] = {
					description: desc,
					value: desc.contributes[extensionPoint.name],
					collector: new ExtensionMessageCollector(messageHandler, desc, extensionPoint.name)
				};
			}
		}

		extensionPoint.acceptUsers(users);
	}

	private _showMessageToUser(severity: Severity, msg: string): void {
		if (severity === Severity.Error || severity === Severity.Warning) {
			this._notificationService.notify({ severity, message: msg });
		} else {
			this._logMessageInConsole(severity, msg);
		}
	}

	private _logMessageInConsole(severity: Severity, msg: string): void {
		if (severity === Severity.Error) {
			console.error(msg);
		} else if (severity === Severity.Warning) {
			console.warn(msg);
		} else {
			console.log(msg);
		}
	}

	// -- called by extension host

	public _logOrShowMessage(severity: Severity, msg: string): void {
		if (this._isDev) {
			this._showMessageToUser(severity, msg);
		} else {
			this._logMessageInConsole(severity, msg);
		}
	}

	public _onExtensionActivated(extensionId: string, startup: boolean, codeLoadingTime: number, activateCallTime: number, activateResolvedTime: number, activationEvent: string): void {
		this._extensionHostProcessActivationTimes[extensionId] = new ActivationTimes(startup, codeLoadingTime, activateCallTime, activateResolvedTime, activationEvent);
		this._onDidChangeExtensionsStatus.fire([extensionId]);
	}

	public _onExtensionRuntimeError(extensionId: string, err: Error): void {
		if (!this._extensionHostExtensionRuntimeErrors[extensionId]) {
			this._extensionHostExtensionRuntimeErrors[extensionId] = [];
		}
		this._extensionHostExtensionRuntimeErrors[extensionId].push(err);
		this._onDidChangeExtensionsStatus.fire([extensionId]);
	}

	public _addMessage(extensionId: string, severity: Severity, message: string): void {
		if (!this._extensionsMessages[extensionId]) {
			this._extensionsMessages[extensionId] = [];
		}
		this._extensionsMessages[extensionId].push({
			type: severity,
			message: message,
			extensionId: null,
			extensionPointId: null
		});
		this._onDidChangeExtensionsStatus.fire([extensionId]);
	}
}
