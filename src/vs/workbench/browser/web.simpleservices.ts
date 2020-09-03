/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from 'vs/base/common/uri';
import * as browser from 'vs/base/browser/browser';
import { IBackupFileService, IResolvedBackup } from 'vs/workbench/services/backup/common/backup';
import { ITextSnapshot } from 'vs/editor/common/model';
import { createTextBufferFactoryFromSnapshot } from 'vs/editor/common/model/textModel';
import { keys } from 'vs/base/common/map';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { Emitter, Event } from 'vs/base/common/event';
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { IClipboardService } from 'vs/platform/clipboard/common/clipboardService';
// tslint:disable-next-line: import-patterns no-standalone-editor
import { IDownloadService } from 'vs/platform/download/common/download';
import { CancellationToken } from 'vs/base/common/cancellation';
import { IExtensionGalleryService, IQueryOptions, IGalleryExtension, InstallOperation, StatisticType, ITranslation, IGalleryExtensionVersion, IExtensionIdentifier, IReportedExtension, IExtensionManagementService, ILocalExtension, IGalleryMetadata, IExtensionTipsService, ExtensionRecommendationReason, IExtensionRecommendation, IExtensionEnablementService, EnablementState } from 'vs/platform/extensionManagement/common/extensionManagement';
import { IPager } from 'vs/base/common/paging';
import { IExtensionManifest, ExtensionType, ExtensionIdentifier, IExtension } from 'vs/platform/extensions/common/extensions';
import { IURLHandler, IURLService } from 'vs/platform/url/common/url';
import { ITelemetryService, ITelemetryData, ITelemetryInfo } from 'vs/platform/telemetry/common/telemetry';
import { ConsoleLogService } from 'vs/platform/log/common/log';
import { ILifecycleService } from 'vs/platform/lifecycle/common/lifecycle';
import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import { IStorageService, IWorkspaceStorageChangeEvent, StorageScope, IWillSaveStateEvent, WillSaveStateReason } from 'vs/platform/storage/common/storage';
import { IUpdateService, State } from 'vs/platform/update/common/update';
import { IWindowService, INativeOpenDialogOptions, IEnterWorkspaceResult, IURIToOpen, IMessageBoxResult, IWindowsService, IOpenSettings, IWindowSettings } from 'vs/platform/windows/common/windows';
import { IWorkspaceIdentifier, ISingleFolderWorkspaceIdentifier, IWorkspaceFolderCreationData, IWorkspacesService } from 'vs/platform/workspaces/common/workspaces';
import { IRecentlyOpened, IRecent, isRecentFile, isRecentFolder } from 'vs/platform/history/common/history';
import { ISerializableCommandAction } from 'vs/platform/actions/common/actions';
import { IWorkspaceEditingService } from 'vs/workbench/services/workspace/common/workspaceEditing';
import { ITunnelService } from 'vs/platform/remote/common/tunnel';
import { IReloadSessionEvent, IExtensionHostDebugService, ICloseSessionEvent, IAttachSessionEvent, ILogToSessionEvent, ITerminateSessionEvent } from 'vs/workbench/services/extensions/common/extensionHostDebug';
import { IRemoteConsoleLog } from 'vs/base/common/console';
// tslint:disable-next-line: import-patterns
// tslint:disable-next-line: import-patterns
import { IExtensionsWorkbenchService, IExtension as IExtension2 } from 'vs/workbench/contrib/extensions/common/extensions';
// tslint:disable-next-line: import-patterns
import { ICommentService, IResourceCommentThreadEvent, IWorkspaceCommentThreadsEvent } from 'vs/workbench/contrib/comments/browser/commentService';
// tslint:disable-next-line: import-patterns
import { ICommentThreadChangedEvent } from 'vs/workbench/contrib/comments/common/commentModel';
import { CommentingRanges } from 'vs/editor/common/modes';
import { Range } from 'vs/editor/common/core/range';
import { isUndefinedOrNull } from 'vs/base/common/types';
import { IWorkspaceContextService, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { addDisposableListener, EventType } from 'vs/base/browser/dom';
import { IEditorService, IResourceEditor } from 'vs/workbench/services/editor/common/editorService';
import { pathsToEditors } from 'vs/workbench/common/editor';
import { IFileService } from 'vs/platform/files/common/files';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ParsedArgs } from 'vs/platform/environment/common/environment';
import { ClassifiedEvent, StrictPropertyCheck, GDPRClassification } from 'vs/platform/telemetry/common/gdprTypings';
import { IProcessEnvironment } from 'vs/base/common/platform';
import { toStoreData, restoreRecentlyOpened } from 'vs/platform/history/common/historyStorage';

//#region Backup File

export class SimpleBackupFileService implements IBackupFileService {

	_serviceBrand: any;

	private backups: Map<string, ITextSnapshot> = new Map();

	hasBackups(): Promise<boolean> {
		return Promise.resolve(this.backups.size > 0);
	}

	loadBackupResource(resource: URI): Promise<URI | undefined> {
		const backupResource = this.toBackupResource(resource);
		if (this.backups.has(backupResource.toString())) {
			return Promise.resolve(backupResource);
		}

		return Promise.resolve(undefined);
	}

	backupResource<T extends object>(resource: URI, content: ITextSnapshot, versionId?: number, meta?: T): Promise<void> {
		const backupResource = this.toBackupResource(resource);
		this.backups.set(backupResource.toString(), content);

		return Promise.resolve();
	}

	resolveBackupContent<T extends object>(backupResource: URI): Promise<IResolvedBackup<T>> {
		const snapshot = this.backups.get(backupResource.toString());
		if (snapshot) {
			return Promise.resolve({ value: createTextBufferFactoryFromSnapshot(snapshot) });
		}

		return Promise.reject('Unexpected backup resource to resolve');
	}

	getWorkspaceFileBackups(): Promise<URI[]> {
		return Promise.resolve(keys(this.backups).map(key => URI.parse(key)));
	}

	discardResourceBackup(resource: URI): Promise<void> {
		this.backups.delete(this.toBackupResource(resource).toString());

		return Promise.resolve();
	}

	discardAllWorkspaceBackups(): Promise<void> {
		this.backups.clear();

		return Promise.resolve();
	}

	toBackupResource(resource: URI): URI {
		return resource;
	}
}

registerSingleton(IBackupFileService, SimpleBackupFileService, true);

//#endregion

//#region Clipboard

export class SimpleClipboardService implements IClipboardService {

	_serviceBrand: any;

	writeText(text: string, type?: string): void { }

	readText(type?: string): string {
		// @ts-ignore
		return undefined;
	}

	readFindText(): string {
		// @ts-ignore
		return undefined;
	}

	writeFindText(text: string): void { }

	writeResources(resources: URI[]): void { }

	readResources(): URI[] {
		return [];
	}

	hasResources(): boolean {
		return false;
	}
}

registerSingleton(IClipboardService, SimpleClipboardService, true);

//#endregion

//#region Dialog

// export class SimpleDialogService extends StandaloneEditorDialogService { }

// registerSingleton(IDialogService, SimpleDialogService, true);

//#endregion

//#region Download

export class SimpleDownloadService implements IDownloadService {

	_serviceBrand: any;

	download(uri: URI, to?: string, cancellationToken?: CancellationToken): Promise<string> {
		// @ts-ignore
		return Promise.resolve(undefined);
	}
}

registerSingleton(IDownloadService, SimpleDownloadService, true);

//#endregion

//#region Extension Gallery

export class SimpleExtensionGalleryService implements IExtensionGalleryService {

	_serviceBrand: any;

	isEnabled(): boolean {
		return false;
	}

	query(token: CancellationToken): Promise<IPager<IGalleryExtension>>;
	query(options: IQueryOptions, token: CancellationToken): Promise<IPager<IGalleryExtension>>;
	query(arg1: any, arg2?: any): Promise<IPager<IGalleryExtension>> {
		// @ts-ignore
		return Promise.resolve(undefined);
	}

	download(extension: IGalleryExtension, operation: InstallOperation): Promise<string> {
		// @ts-ignore
		return Promise.resolve(undefined);
	}

	reportStatistic(publisher: string, name: string, version: string, type: StatisticType): Promise<void> {
		return Promise.resolve(undefined);
	}

	getReadme(extension: IGalleryExtension, token: CancellationToken): Promise<string> {
		// @ts-ignore
		return Promise.resolve(undefined);
	}

	getManifest(extension: IGalleryExtension, token: CancellationToken): Promise<IExtensionManifest> {
		// @ts-ignore
		return Promise.resolve(undefined);
	}

	getChangelog(extension: IGalleryExtension, token: CancellationToken): Promise<string> {
		// @ts-ignore
		return Promise.resolve(undefined);
	}

	getCoreTranslation(extension: IGalleryExtension, languageId: string): Promise<ITranslation> {
		// @ts-ignore
		return Promise.resolve(undefined);
	}

	getAllVersions(extension: IGalleryExtension, compatible: boolean): Promise<IGalleryExtensionVersion[]> {
		// @ts-ignore
		return Promise.resolve(undefined);
	}

	getExtensionsReport(): Promise<IReportedExtension[]> {
		// @ts-ignore
		return Promise.resolve(undefined);
	}

	// @ts-ignore
	getCompatibleExtension(extension: IGalleryExtension): Promise<IGalleryExtension>;
	getCompatibleExtension(id: IExtensionIdentifier, version?: string): Promise<IGalleryExtension>;
	getCompatibleExtension(id: any, version?: any) {
		return Promise.resolve(undefined);
	}
}

registerSingleton(IExtensionGalleryService, SimpleExtensionGalleryService, true);

//#endregion

//#endregion IExtensionsWorkbenchService
export class SimpleExtensionsWorkbenchService implements IExtensionsWorkbenchService {
	_serviceBrand: any;
	onChange: Event<IExtension2 | undefined>;
	local: IExtension2[];
	installed: IExtension2[];
	outdated: IExtension2[];
	queryLocal: any;
	queryGallery: any;
	canInstall: any;
	install: any;
	uninstall: any;
	installVersion: any;
	reinstall: any;
	setEnablement: any;
	open: any;
	checkForUpdates: any;
	allowedBadgeProviders: string[];
}
registerSingleton(IExtensionsWorkbenchService, SimpleExtensionsWorkbenchService, true);
//#endregion

//#region ICommentService
export class SimpleCommentService implements ICommentService {
	_serviceBrand: any;
	onDidSetResourceCommentInfos: Event<IResourceCommentThreadEvent> = Event.None;
	onDidSetAllCommentThreads: Event<IWorkspaceCommentThreadsEvent> = Event.None;
	onDidUpdateCommentThreads: Event<ICommentThreadChangedEvent> = Event.None;
	onDidChangeActiveCommentingRange: Event<{ range: Range; commentingRangesInfo: CommentingRanges; }> = Event.None;
	onDidChangeActiveCommentThread: Event<any> = Event.None;
	onDidSetDataProvider: Event<void> = Event.None;
	onDidDeleteDataProvider: Event<string> = Event.None;
	setDocumentComments: any;
	setWorkspaceComments: any;
	removeWorkspaceComments: any;
	registerCommentController: any;
	unregisterCommentController: any;
	getCommentController: any;
	createCommentThreadTemplate: any;
	updateCommentThreadTemplate: any;
	getCommentMenus: any;
	registerDataProvider: any;
	unregisterDataProvider: any;
	updateComments: any;
	disposeCommentThread: any;
	createNewCommentThread: any;
	replyToCommentThread: any;
	editComment: any;
	deleteComment: any;
	getComments() { return Promise.resolve([]); }
	getCommentingRanges: any;
	startDraft: any;
	deleteDraft: any;
	finishDraft: any;
	getStartDraftLabel: any;
	getDeleteDraftLabel: any;
	getFinishDraftLabel: any;
	addReaction: any;
	deleteReaction: any;
	getReactionGroup: any;
	hasReactionHandler: any;
	toggleReaction: any;
	setActiveCommentThread: any;
}
registerSingleton(ICommentService, SimpleCommentService, true);
//#endregion

//#region Extension Management

//#region Extension Enablement

export class SimpleExtensionEnablementService implements IExtensionEnablementService {

	_serviceBrand: any;

	readonly onEnablementChanged = Event.None;

	readonly allUserExtensionsDisabled = false;

	getEnablementState(extension: IExtension): EnablementState {
		return EnablementState.Enabled;
	}

	canChangeEnablement(extension: IExtension): boolean {
		return false;
	}

	setEnablement(extensions: IExtension[], newState: EnablementState): Promise<boolean[]> {
		throw new Error('not implemented');
	}

	isEnabled(extension: IExtension): boolean {
		return true;
	}

}

registerSingleton(IExtensionEnablementService, SimpleExtensionEnablementService, true);

//#endregion

//#region Extension Tips

export class SimpleExtensionTipsService implements IExtensionTipsService {
	_serviceBrand: any;

	onRecommendationChange = Event.None;

	getAllRecommendationsWithReason(): { [id: string]: { reasonId: ExtensionRecommendationReason; reasonText: string; }; } {
		return Object.create(null);
	}

	getFileBasedRecommendations(): IExtensionRecommendation[] {
		return [];
	}

	getOtherRecommendations(): Promise<IExtensionRecommendation[]> {
		return Promise.resolve([]);
	}

	getWorkspaceRecommendations(): Promise<IExtensionRecommendation[]> {
		return Promise.resolve([]);
	}

	getKeymapRecommendations(): IExtensionRecommendation[] {
		return [];
	}

	toggleIgnoredRecommendation(extensionId: string, shouldIgnore: boolean): void {
	}

	getAllIgnoredRecommendations(): { global: string[]; workspace: string[]; } {
		return Object.create(null);
	}
}

registerSingleton(IExtensionTipsService, SimpleExtensionTipsService, true);

//#endregion

export class SimpleExtensionManagementService implements IExtensionManagementService {

	_serviceBrand: any;

	onInstallExtension = Event.None;
	onDidInstallExtension = Event.None;
	onUninstallExtension = Event.None;
	onDidUninstallExtension = Event.None;

	zip(extension: ILocalExtension): Promise<URI> {
		// @ts-ignore
		return Promise.resolve(undefined);
	}

	unzip(zipLocation: URI, type: ExtensionType): Promise<IExtensionIdentifier> {
		// @ts-ignore
		return Promise.resolve(undefined);
	}

	install(vsix: URI): Promise<ILocalExtension> {
		// @ts-ignore
		return Promise.resolve(undefined);
	}

	installFromGallery(extension: IGalleryExtension): Promise<ILocalExtension> {
		// @ts-ignore
		return Promise.resolve(undefined);
	}

	uninstall(extension: ILocalExtension, force?: boolean): Promise<void> {
		return Promise.resolve(undefined);
	}

	reinstallFromGallery(extension: ILocalExtension): Promise<void> {
		return Promise.resolve(undefined);
	}

	getInstalled(type?: ExtensionType): Promise<ILocalExtension[]> {
		// @ts-ignore
		return Promise.resolve(undefined);
	}

	getExtensionsReport(): Promise<IReportedExtension[]> {
		// @ts-ignore
		return Promise.resolve(undefined);
	}

	updateMetadata(local: ILocalExtension, metadata: IGalleryMetadata): Promise<ILocalExtension> {
		// @ts-ignore
		return Promise.resolve(undefined);
	}
}

registerSingleton(IExtensionManagementService, SimpleExtensionManagementService);

//#endregion

//#region Extension URL Handler

export const IExtensionUrlHandler = createDecorator<IExtensionUrlHandler>('inactiveExtensionUrlHandler');

export interface IExtensionUrlHandler {
	readonly _serviceBrand: any;
	registerExtensionHandler(extensionId: ExtensionIdentifier, handler: IURLHandler): void;
	unregisterExtensionHandler(extensionId: ExtensionIdentifier): void;
}

export class SimpleExtensionURLHandler implements IExtensionUrlHandler {

	_serviceBrand: any;

	registerExtensionHandler(extensionId: ExtensionIdentifier, handler: IURLHandler): void { }

	unregisterExtensionHandler(extensionId: ExtensionIdentifier): void { }
}

registerSingleton(IExtensionUrlHandler, SimpleExtensionURLHandler, true);

//#endregion

//#region Log

export class SimpleLogService extends ConsoleLogService { }

//#endregion

//#region Multi Extension Management

export class SimpleMultiExtensionsManagementService implements IExtensionManagementService {

	_serviceBrand: any;

	onInstallExtension = Event.None;
	onDidInstallExtension = Event.None;
	onUninstallExtension = Event.None;
	onDidUninstallExtension = Event.None;

	zip(extension: ILocalExtension): Promise<URI> {
		// @ts-ignore
		return Promise.resolve(undefined);
	}

	unzip(zipLocation: URI, type: ExtensionType): Promise<IExtensionIdentifier> {
		// @ts-ignore
		return Promise.resolve(undefined);
	}

	install(vsix: URI): Promise<ILocalExtension> {
		// @ts-ignore
		return Promise.resolve(undefined);
	}

	installFromGallery(extension: IGalleryExtension): Promise<ILocalExtension> {
		// @ts-ignore
		return Promise.resolve(undefined);
	}

	uninstall(extension: ILocalExtension, force?: boolean): Promise<void> {
		return Promise.resolve(undefined);
	}

	reinstallFromGallery(extension: ILocalExtension): Promise<void> {
		return Promise.resolve(undefined);
	}

	getInstalled(type?: ExtensionType): Promise<ILocalExtension[]> {
		// @ts-ignore
		return Promise.resolve(undefined);
	}

	getExtensionsReport(): Promise<IReportedExtension[]> {
		// @ts-ignore
		return Promise.resolve(undefined);
	}

	updateMetadata(local: ILocalExtension, metadata: IGalleryMetadata): Promise<ILocalExtension> {
		// @ts-ignore
		return Promise.resolve(undefined);
	}
}

//#endregion

//#region Request

export const IRequestService = createDecorator<IRequestService>('requestService');

export interface IRequestService {
	_serviceBrand: any;

	request(options: any, token: CancellationToken): Promise<object>;
}

export class SimpleRequestService implements IRequestService {

	_serviceBrand: any;

	request(options: any, token: CancellationToken): Promise<object> {
		return Promise.resolve(Object.create(null));
	}
}

//#endregion

//#region Storage

export class LocalStorageService extends Disposable implements IStorageService {
	_serviceBrand = undefined;

	private readonly _onDidChangeStorage: Emitter<IWorkspaceStorageChangeEvent> = this._register(new Emitter<IWorkspaceStorageChangeEvent>());
	get onDidChangeStorage(): Event<IWorkspaceStorageChangeEvent> { return this._onDidChangeStorage.event; }

	private readonly _onWillSaveState: Emitter<IWillSaveStateEvent> = this._register(new Emitter<IWillSaveStateEvent>());
	get onWillSaveState(): Event<IWillSaveStateEvent> { return this._onWillSaveState.event; }

	constructor(
		@IWorkspaceContextService private workspaceContextService: IWorkspaceContextService,
		@ILifecycleService lifecycleService: ILifecycleService
	) {
		super();

		this._register(lifecycleService.onBeforeShutdown(() => this._onWillSaveState.fire({ reason: WillSaveStateReason.SHUTDOWN })));
	}

	private toKey(key: string, scope: StorageScope): string {
		if (scope === StorageScope.GLOBAL) {
			return `global://${key}`;
		}

		return `workspace://${this.workspaceContextService.getWorkspace().id}/${key}`;
	}

	get(key: string, scope: StorageScope, fallbackValue: string): string;
	get(key: string, scope: StorageScope, fallbackValue?: string): string | undefined {
		const value = window.localStorage.getItem(this.toKey(key, scope));

		if (isUndefinedOrNull(value)) {
			return fallbackValue;
		}

		return value;
	}

	getBoolean(key: string, scope: StorageScope, fallbackValue: boolean): boolean;
	getBoolean(key: string, scope: StorageScope, fallbackValue?: boolean): boolean | undefined {
		const value = window.localStorage.getItem(this.toKey(key, scope));

		if (isUndefinedOrNull(value)) {
			return fallbackValue;
		}

		return value === 'true';
	}

	getNumber(key: string, scope: StorageScope, fallbackValue: number): number;
	getNumber(key: string, scope: StorageScope, fallbackValue?: number): number | undefined {
		const value = window.localStorage.getItem(this.toKey(key, scope));

		if (isUndefinedOrNull(value)) {
			return fallbackValue;
		}

		return parseInt(value, 10);
	}

	store(key: string, value: string | boolean | number | undefined | null, scope: StorageScope): Promise<void> {

		// We remove the key for undefined/null values
		if (isUndefinedOrNull(value)) {
			return this.remove(key, scope);
		}

		// Otherwise, convert to String and store
		const valueStr = String(value);

		// Return early if value already set
		const currentValue = window.localStorage.getItem(this.toKey(key, scope));
		if (currentValue === valueStr) {
			return Promise.resolve();
		}

		// Update in cache
		window.localStorage.setItem(this.toKey(key, scope), valueStr);

		// Events
		this._onDidChangeStorage.fire({ scope, key });

		return Promise.resolve();
	}

	remove(key: string, scope: StorageScope): Promise<void> {
		const wasDeleted = window.localStorage.getItem(this.toKey(key, scope));
		window.localStorage.removeItem(this.toKey(key, scope));

		if (!wasDeleted) {
			return Promise.resolve(); // Return early if value already deleted
		}

		// Events
		this._onDidChangeStorage.fire({ scope, key });

		return Promise.resolve();
	}
}

registerSingleton(IStorageService, LocalStorageService);

//#endregion

//#region Telemetry

export class SimpleTelemetryService implements ITelemetryService {

	_serviceBrand: undefined;

	isOptedIn: true;

	publicLog(eventName: string, data?: ITelemetryData) {
		return Promise.resolve(undefined);
	}

	publicLog2<E extends ClassifiedEvent<T> = never, T extends GDPRClassification<T> = never>(eventName: string, data?: StrictPropertyCheck<T, E>) {
		return this.publicLog(eventName, data as ITelemetryData);
	}

	setEnabled(value: boolean): void {
	}

	getTelemetryInfo(): Promise<ITelemetryInfo> {
		return Promise.resolve({
			instanceId: 'someValue.instanceId',
			sessionId: 'someValue.sessionId',
			machineId: 'someValue.machineId'
		});
	}
}

registerSingleton(ITelemetryService, SimpleTelemetryService);

//#endregion

//#region Update

export class SimpleUpdateService implements IUpdateService {

	_serviceBrand: any;

	onStateChange = Event.None;
	state: State;

	checkForUpdates(context: any): Promise<void> {
		return Promise.resolve(undefined);
	}

	downloadUpdate(): Promise<void> {
		return Promise.resolve(undefined);
	}

	applyUpdate(): Promise<void> {
		return Promise.resolve(undefined);
	}

	quitAndInstall(): Promise<void> {
		return Promise.resolve(undefined);
	}

	isLatestVersion(): Promise<boolean> {
		return Promise.resolve(true);
	}
}

registerSingleton(IUpdateService, SimpleUpdateService);

//#endregion

//#region URL

export class SimpleURLService implements IURLService {
	_serviceBrand: any;

	open(url: URI): Promise<boolean> {
		return Promise.resolve(false);
	}

	registerHandler(handler: IURLHandler): IDisposable {
		return Disposable.None;
	}
}

registerSingleton(IURLService, SimpleURLService);

//#endregion

//#region Window

export class SimpleWindowService extends Disposable implements IWindowService {

	_serviceBrand: any;

	readonly onDidChangeFocus: Event<boolean> = Event.None;
	readonly onDidChangeMaximize: Event<boolean> = Event.None;

	readonly hasFocus = true;

	readonly windowId = 0;

	static readonly RECENTLY_OPENED_KEY = 'recently.opened';

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IFileService private readonly fileService: IFileService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService
	) {
		super();

		this.addWorkspaceToRecentlyOpened();
		this.registerListeners();
	}

	private addWorkspaceToRecentlyOpened(): void {
		const workspace = this.workspaceService.getWorkspace();
		switch (this.workspaceService.getWorkbenchState()) {
			case WorkbenchState.FOLDER:
				this.addRecentlyOpened([{ folderUri: workspace.folders[0].uri }]);
				break;
			case WorkbenchState.WORKSPACE:
				this.addRecentlyOpened([{ workspace: { id: workspace.id, configPath: workspace.configuration! } }]);
				break;
		}
	}

	private registerListeners(): void {
		this._register(addDisposableListener(document, EventType.FULLSCREEN_CHANGE, () => {
			if (document.fullscreenElement || (<any>document).webkitFullscreenElement) {
				browser.setFullscreen(true);
			} else {
				browser.setFullscreen(false);
			}
		}));

		this._register(addDisposableListener(document, EventType.WK_FULLSCREEN_CHANGE, () => {
			if (document.fullscreenElement || (<any>document).webkitFullscreenElement || (<any>document).webkitIsFullScreen) {
				browser.setFullscreen(true);
			} else {
				browser.setFullscreen(false);
			}
		}));
	}

	isFocused(): Promise<boolean> {
		return Promise.resolve(this.hasFocus);
	}

	isMaximized(): Promise<boolean> {
		return Promise.resolve(false);
	}

	pickFileFolderAndOpen(_options: INativeOpenDialogOptions): Promise<void> {
		return Promise.resolve();
	}

	pickFileAndOpen(_options: INativeOpenDialogOptions): Promise<void> {
		return Promise.resolve();
	}

	pickFolderAndOpen(_options: INativeOpenDialogOptions): Promise<void> {
		return Promise.resolve();
	}

	pickWorkspaceAndOpen(_options: INativeOpenDialogOptions): Promise<void> {
		return Promise.resolve();
	}

	reloadWindow(): Promise<void> {
		window.location.reload();

		return Promise.resolve();
	}

	openDevTools(): Promise<void> {
		return Promise.resolve();
	}

	toggleDevTools(): Promise<void> {
		return Promise.resolve();
	}

	closeWorkspace(): Promise<void> {
		return Promise.resolve();
	}

	enterWorkspace(_path: URI): Promise<IEnterWorkspaceResult | undefined> {
		return Promise.resolve(undefined);
	}

	toggleFullScreen(target?: HTMLElement): Promise<void> {
		if (!target) {
			return Promise.resolve();
		}

		// Chromium
		if ((<any>document).fullscreen !== undefined) {
			if (!(<any>document).fullscreen) {

				return (<any>target).requestFullscreen().catch(() => {
					// if it fails, chromium throws an exception with error undefined.
					// re https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen
					console.warn('Toggle Full Screen failed');
				});
			} else {
				return document.exitFullscreen().catch(() => {
					console.warn('Exit Full Screen failed');
				});
			}
		}

		// Safari and Edge 14 are all using webkit prefix
		if ((<any>document).webkitIsFullScreen !== undefined) {
			try {
				if (!(<any>document).webkitIsFullScreen) {
					(<any>target).webkitRequestFullscreen(); // it's async, but doesn't return a real promise.
				} else {
					(<any>document).webkitExitFullscreen(); // it's async, but doesn't return a real promise.
				}
			} catch {
				console.warn('Enter/Exit Full Screen failed');
			}
		}

		return Promise.resolve();
	}

	setRepresentedFilename(_fileName: string): Promise<void> {
		return Promise.resolve();
	}

	async getRecentlyOpened(): Promise<IRecentlyOpened> {
		const recentlyOpenedRaw = this.storageService.get(SimpleWindowService.RECENTLY_OPENED_KEY, StorageScope.GLOBAL);
		if (recentlyOpenedRaw) {
			return restoreRecentlyOpened(JSON.parse(recentlyOpenedRaw));
		}

		return { workspaces: [], files: [] };
	}

	async addRecentlyOpened(recents: IRecent[]): Promise<void> {
		const recentlyOpened = await this.getRecentlyOpened();

		recents.forEach(recent => {
			if (isRecentFile(recent)) {
				this.doRemoveFromRecentlyOpened(recentlyOpened, [recent.fileUri]);
				recentlyOpened.files.unshift(recent);
			} else if (isRecentFolder(recent)) {
				this.doRemoveFromRecentlyOpened(recentlyOpened, [recent.folderUri]);
				recentlyOpened.workspaces.unshift(recent);
			} else {
				this.doRemoveFromRecentlyOpened(recentlyOpened, [recent.workspace.configPath]);
				recentlyOpened.workspaces.unshift(recent);
			}
		});

		return this.saveRecentlyOpened(recentlyOpened);
	}

	async removeFromRecentlyOpened(paths: URI[]): Promise<void> {
		const recentlyOpened = await this.getRecentlyOpened();

		this.doRemoveFromRecentlyOpened(recentlyOpened, paths);

		return this.saveRecentlyOpened(recentlyOpened);
	}

	private doRemoveFromRecentlyOpened(recentlyOpened: IRecentlyOpened, paths: URI[]): void {
		recentlyOpened.files = recentlyOpened.files.filter(file => {
			return !paths.some(path => path.toString() === file.fileUri.toString());
		});

		recentlyOpened.workspaces = recentlyOpened.workspaces.filter(workspace => {
			return !paths.some(path => path.toString() === (isRecentFolder(workspace) ? workspace.folderUri.toString() : workspace.workspace.configPath.toString()));
		});
	}

	private async saveRecentlyOpened(data: IRecentlyOpened): Promise<void> {
		return this.storageService.store(SimpleWindowService.RECENTLY_OPENED_KEY, JSON.stringify(toStoreData(data)), StorageScope.GLOBAL);
	}

	focusWindow(): Promise<void> {
		return Promise.resolve();
	}

	maximizeWindow(): Promise<void> {
		return Promise.resolve();
	}

	unmaximizeWindow(): Promise<void> {
		return Promise.resolve();
	}

	minimizeWindow(): Promise<void> {
		return Promise.resolve();
	}

	async openWindow(_uris: IURIToOpen[], _options?: IOpenSettings): Promise<void> {
		const { openFolderInNewWindow } = this.shouldOpenNewWindow(_options);
		for (let i = 0; i < _uris.length; i++) {
			const uri = _uris[i];
			if ('folderUri' in uri) {
				const newAddress = `${document.location.origin}/?folder=${uri.folderUri.path}`;
				if (openFolderInNewWindow) {
					window.open(newAddress);
				} else {
					window.location.href = newAddress;
				}
			}
			if ('workspaceUri' in uri) {
				const newAddress = `${document.location.origin}/?workspace=${uri.workspaceUri.path}`;
				if (openFolderInNewWindow) {
					window.open(newAddress);
				} else {
					window.location.href = newAddress;
				}
			}
			if ('fileUri' in uri) {
				const inputs: IResourceEditor[] = await pathsToEditors([uri], this.fileService);
				this.editorService.openEditors(inputs);
			}
		}
		return Promise.resolve();
	}

	private shouldOpenNewWindow(_options: IOpenSettings = {}): { openFolderInNewWindow: boolean } {
		const windowConfig = this.configurationService.getValue<IWindowSettings>('window');
		const openFolderInNewWindowConfig = (windowConfig && windowConfig.openFoldersInNewWindow) || 'default' /* default */;
		let openFolderInNewWindow = !!_options.forceNewWindow && !_options.forceReuseWindow;
		if (!_options.forceNewWindow && !_options.forceReuseWindow && (openFolderInNewWindowConfig === 'on' || openFolderInNewWindowConfig === 'off')) {
			openFolderInNewWindow = (openFolderInNewWindowConfig === 'on');
		}
		return { openFolderInNewWindow };
	}

	closeWindow(): Promise<void> {
		return Promise.resolve();
	}

	setDocumentEdited(_flag: boolean): Promise<void> {
		return Promise.resolve();
	}

	onWindowTitleDoubleClick(): Promise<void> {
		return Promise.resolve();
	}

	showMessageBox(_options: Electron.MessageBoxOptions): Promise<IMessageBoxResult> {
		return Promise.resolve({ button: 0 });
	}

	showSaveDialog(_options: Electron.SaveDialogOptions): Promise<string> {
		throw new Error('not implemented');
	}

	showOpenDialog(_options: Electron.OpenDialogOptions): Promise<string[]> {
		throw new Error('not implemented');
	}

	updateTouchBar(_items: ISerializableCommandAction[][]): Promise<void> {
		return Promise.resolve();
	}

	resolveProxy(url: string): Promise<string | undefined> {
		return Promise.resolve(undefined);
	}
}

registerSingleton(IWindowService, SimpleWindowService);

//#endregion

//#region ExtensionHostDebugService

export class SimpleExtensionHostDebugService implements IExtensionHostDebugService {
	_serviceBrand: any;

	reload(sessionId: string): void { }
	onReload: Event<IReloadSessionEvent> = Event.None;

	close(sessionId: string): void { }
	onClose: Event<ICloseSessionEvent> = Event.None;

	attachSession(sessionId: string, port: number, subId?: string): void { }
	onAttachSession: Event<IAttachSessionEvent> = Event.None;

	logToSession(sessionId: string, log: IRemoteConsoleLog): void { }
	onLogToSession: Event<ILogToSessionEvent> = Event.None;

	terminateSession(sessionId: string, subId?: string): void { }
	onTerminateSession: Event<ITerminateSessionEvent> = Event.None;
}
registerSingleton(IExtensionHostDebugService, SimpleExtensionHostDebugService);

//#endregion

//#region Window

export class SimpleWindowsService implements IWindowsService {
	_serviceBrand: any;

	windowCount = 1;

	readonly onWindowOpen: Event<number> = Event.None;
	readonly onWindowFocus: Event<number> = Event.None;
	readonly onWindowBlur: Event<number> = Event.None;
	readonly onWindowMaximize: Event<number> = Event.None;
	readonly onWindowUnmaximize: Event<number> = Event.None;
	readonly onRecentlyOpenedChange: Event<void> = Event.None;

	isFocused(_windowId: number): Promise<boolean> {
		return Promise.resolve(true);
	}

	pickFileFolderAndOpen(_options: INativeOpenDialogOptions): Promise<void> {
		return Promise.resolve();
	}

	pickFileAndOpen(_options: INativeOpenDialogOptions): Promise<void> {
		return Promise.resolve();
	}

	pickFolderAndOpen(_options: INativeOpenDialogOptions): Promise<void> {
		return Promise.resolve();
	}

	pickWorkspaceAndOpen(_options: INativeOpenDialogOptions): Promise<void> {
		return Promise.resolve();
	}

	reloadWindow(_windowId: number): Promise<void> {
		return Promise.resolve();
	}

	openDevTools(_windowId: number): Promise<void> {
		return Promise.resolve();
	}

	toggleDevTools(_windowId: number): Promise<void> {
		return Promise.resolve();
	}

	closeWorkspace(_windowId: number): Promise<void> {
		return Promise.resolve();
	}

	enterWorkspace(_windowId: number, _path: URI): Promise<IEnterWorkspaceResult | undefined> {
		return Promise.resolve(undefined);
	}

	toggleFullScreen(_windowId: number): Promise<void> {
		return Promise.resolve();
	}

	setRepresentedFilename(_windowId: number, _fileName: string): Promise<void> {
		return Promise.resolve();
	}

	addRecentlyOpened(recents: IRecent[]): Promise<void> {
		return Promise.resolve();
	}

	removeFromRecentlyOpened(_paths: URI[]): Promise<void> {
		return Promise.resolve();
	}

	clearRecentlyOpened(): Promise<void> {
		return Promise.resolve();
	}

	getRecentlyOpened(_windowId: number): Promise<IRecentlyOpened> {
		return Promise.resolve({
			workspaces: [],
			files: []
		});
	}

	focusWindow(_windowId: number): Promise<void> {
		return Promise.resolve();
	}

	closeWindow(_windowId: number): Promise<void> {
		return Promise.resolve();
	}

	isMaximized(_windowId: number): Promise<boolean> {
		return Promise.resolve(false);
	}

	maximizeWindow(_windowId: number): Promise<void> {
		return Promise.resolve();
	}

	minimizeWindow(_windowId: number): Promise<void> {
		return Promise.resolve();
	}

	unmaximizeWindow(_windowId: number): Promise<void> {
		return Promise.resolve();
	}

	onWindowTitleDoubleClick(_windowId: number): Promise<void> {
		return Promise.resolve();
	}

	setDocumentEdited(_windowId: number, _flag: boolean): Promise<void> {
		return Promise.resolve();
	}

	quit(): Promise<void> {
		return Promise.resolve();
	}

	relaunch(_options: { addArgs?: string[], removeArgs?: string[] }): Promise<void> {
		return Promise.resolve();
	}

	whenSharedProcessReady(): Promise<void> {
		return Promise.resolve();
	}

	toggleSharedProcess(): Promise<void> {
		return Promise.resolve();
	}

	// Global methods
	openWindow(_windowId: number, _uris: IURIToOpen[], _options: IOpenSettings): Promise<void> {
		return Promise.resolve();
	}

	openNewWindow(): Promise<void> {
		return Promise.resolve();
	}

	openExtensionDevelopmentHostWindow(args: ParsedArgs, env: IProcessEnvironment): Promise<void> {
		return Promise.resolve();
	}

	getWindows(): Promise<{ id: number; workspace?: IWorkspaceIdentifier; folderUri?: ISingleFolderWorkspaceIdentifier; title: string; filename?: string; }[]> {
		return Promise.resolve([]);
	}

	getWindowCount(): Promise<number> {
		return Promise.resolve(this.windowCount);
	}

	log(_severity: string, ..._messages: string[]): Promise<void> {
		return Promise.resolve();
	}

	showItemInFolder(_path: URI): Promise<void> {
		return Promise.resolve();
	}

	newWindowTab(): Promise<void> {
		return Promise.resolve();
	}

	showPreviousWindowTab(): Promise<void> {
		return Promise.resolve();
	}

	showNextWindowTab(): Promise<void> {
		return Promise.resolve();
	}

	moveWindowTabToNewWindow(): Promise<void> {
		return Promise.resolve();
	}

	mergeAllWindowTabs(): Promise<void> {
		return Promise.resolve();
	}

	toggleWindowTabsBar(): Promise<void> {
		return Promise.resolve();
	}

	updateTouchBar(_windowId: number, _items: ISerializableCommandAction[][]): Promise<void> {
		return Promise.resolve();
	}

	getActiveWindowId(): Promise<number | undefined> {
		return Promise.resolve(undefined);
	}

	// This needs to be handled from browser process to prevent
	// foreground ordering issues on Windows
	openExternal(_url: string): Promise<boolean> {
		return Promise.resolve(true);
	}

	// TODO: this is a bit backwards
	startCrashReporter(_config: Electron.CrashReporterStartOptions): Promise<void> {
		return Promise.resolve();
	}

	showMessageBox(_windowId: number, _options: Electron.MessageBoxOptions): Promise<IMessageBoxResult> {
		throw new Error('not implemented');
	}

	showSaveDialog(_windowId: number, _options: Electron.SaveDialogOptions): Promise<string> {
		throw new Error('not implemented');
	}

	showOpenDialog(_windowId: number, _options: Electron.OpenDialogOptions): Promise<string[]> {
		throw new Error('not implemented');
	}

	openAboutDialog(): Promise<void> {
		return Promise.resolve();
	}

	resolveProxy(windowId: number, url: string): Promise<string | undefined> {
		return Promise.resolve(undefined);
	}
}

registerSingleton(IWindowsService, SimpleWindowsService);

//#endregion

//#region Workspace Editing

export class SimpleWorkspaceEditingService implements IWorkspaceEditingService {

	_serviceBrand: any;

	addFolders(folders: IWorkspaceFolderCreationData[], donotNotifyError?: boolean): Promise<void> {
		return Promise.resolve(undefined);
	}

	removeFolders(folders: URI[], donotNotifyError?: boolean): Promise<void> {
		return Promise.resolve(undefined);
	}

	updateFolders(index: number, deleteCount?: number, foldersToAdd?: IWorkspaceFolderCreationData[], donotNotifyError?: boolean): Promise<void> {
		return Promise.resolve(undefined);
	}

	enterWorkspace(path: URI): Promise<void> {
		return Promise.resolve(undefined);
	}

	createAndEnterWorkspace(folders: IWorkspaceFolderCreationData[], path?: URI): Promise<void> {
		return Promise.resolve(undefined);
	}

	saveAndEnterWorkspace(path: URI): Promise<void> {
		return Promise.resolve(undefined);
	}

	copyWorkspaceSettings(toWorkspace: IWorkspaceIdentifier): Promise<void> {
		return Promise.resolve(undefined);
	}

	pickNewWorkspacePath(): Promise<URI> {
		// @ts-ignore
		return Promise.resolve(undefined);
	}
}

registerSingleton(IWorkspaceEditingService, SimpleWorkspaceEditingService, true);

//#endregion

//#region Workspaces

export class SimpleWorkspacesService implements IWorkspacesService {

	_serviceBrand: any;

	createUntitledWorkspace(folders?: IWorkspaceFolderCreationData[], remoteAuthority?: string): Promise<IWorkspaceIdentifier> {
		// @ts-ignore
		return Promise.resolve(undefined);
	}

	deleteUntitledWorkspace(workspace: IWorkspaceIdentifier): Promise<void> {
		return Promise.resolve(undefined);
	}

	getWorkspaceIdentifier(workspacePath: URI): Promise<IWorkspaceIdentifier> {
		// @ts-ignore
		return Promise.resolve(undefined);
	}
}

registerSingleton(IWorkspacesService, SimpleWorkspacesService);

//#endregion

//#region remote

class SimpleTunnelService implements ITunnelService {
	_serviceBrand: any;
	openTunnel(remotePort: number) {
		return undefined;
	}
}

registerSingleton(ITunnelService, SimpleTunnelService);

//#endregion