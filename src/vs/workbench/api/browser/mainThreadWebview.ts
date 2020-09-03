/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from 'vs/base/common/errors';
import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import * as map from 'vs/base/common/map';
import { URI, UriComponents } from 'vs/base/common/uri';
import * as modes from 'vs/editor/common/modes';
import { localize } from 'vs/nls';
import { ExtensionIdentifier } from 'vs/platform/extensions/common/extensions';
import { ILifecycleService } from 'vs/platform/lifecycle/common/lifecycle';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { ExtHostContext, ExtHostWebviewsShape, IExtHostContext, MainContext, MainThreadWebviewsShape, WebviewPanelHandle, WebviewPanelShowOptions } from 'vs/workbench/api/common/extHost.protocol';
import { editorGroupToViewColumn, EditorViewColumn, viewColumnToEditorGroup } from 'vs/workbench/api/common/shared/editor';
import { WebviewEditor } from 'vs/workbench/contrib/webview/browser/webviewEditor';
import { WebviewEditorInput } from 'vs/workbench/contrib/webview/browser/webviewEditorInput';
import { ICreateWebViewShowOptions, IWebviewEditorService, WebviewInputOptions } from 'vs/workbench/contrib/webview/browser/webviewEditorService';
import { IEditorGroupsService } from 'vs/workbench/services/editor/common/editorGroupsService';
import { ACTIVE_GROUP, IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { extHostNamedCustomer } from '../common/extHostCustomers';
import { IProductService } from 'vs/platform/product/common/product';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';

@extHostNamedCustomer(MainContext.MainThreadWebviews)
export class MainThreadWebviews extends Disposable implements MainThreadWebviewsShape {

	private static readonly standardSupportedLinkSchemes = new Set([
		'http',
		'https',
		'mailto',
		'vscode',
		'vscode-insider',
	]);

	private static revivalPool = 0;


	private readonly _proxy: ExtHostWebviewsShape;
	private readonly _webviews = new Map<WebviewPanelHandle, WebviewEditorInput>();
	private readonly _revivers = new Map<string, IDisposable>();

	private _activeWebview: WebviewPanelHandle | undefined = undefined;

	constructor(
		context: IExtHostContext,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IExtensionService extensionService: IExtensionService,
		@IEditorGroupsService private readonly _editorGroupService: IEditorGroupsService,
		@IEditorService private readonly _editorService: IEditorService,
		@IWebviewEditorService private readonly _webviewService: IWebviewEditorService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IProductService private readonly _productService: IProductService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
	) {
		super();

		this._proxy = context.getProxy(ExtHostContext.ExtHostWebviews);
		this._register(_editorService.onDidActiveEditorChange(this.onActiveEditorChanged, this));
		this._register(_editorService.onDidVisibleEditorsChange(this.onVisibleEditorsChanged, this));

		// This reviver's only job is to activate webview extensions
		// This should trigger the real reviver to be registered from the extension host side.
		this._register(_webviewService.registerReviver({
			canRevive: (webview) => {
				const viewType = webview.state.viewType;
				if (viewType) {
					extensionService.activateByEvent(`onWebviewPanel:${viewType}`);
				}
				return false;
			},
			reviveWebview: () => { throw new Error('not implemented'); }
		}));

		this._register(lifecycleService.onBeforeShutdown(e => {
			this._onBeforeShutdown();
			e.veto(false); // Don't veto shutdown
		}, this));
	}

	public $createWebviewPanel(
		handle: WebviewPanelHandle,
		viewType: string,
		title: string,
		showOptions: { viewColumn?: EditorViewColumn, preserveFocus?: boolean },
		options: WebviewInputOptions,
		extensionId: ExtensionIdentifier,
		extensionLocation: UriComponents
	): void {
		const mainThreadShowOptions: ICreateWebViewShowOptions = Object.create(null);
		if (showOptions) {
			mainThreadShowOptions.preserveFocus = !!showOptions.preserveFocus;
			mainThreadShowOptions.group = viewColumnToEditorGroup(this._editorGroupService, showOptions.viewColumn);
		}

		const webview = this._webviewService.createWebview(this.getInternalWebviewId(viewType), title, mainThreadShowOptions, reviveWebviewOptions(options), {
			location: URI.revive(extensionLocation),
			id: extensionId
		}, this.createWebviewEventDelegate(handle));
		webview.state = {
			viewType: viewType,
			state: undefined
		};

		this._webviews.set(handle, webview);

		/* __GDPR__
			"webviews:createWebviewPanel" : {
				"extensionId" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
			}
		*/
		this._telemetryService.publicLog('webviews:createWebviewPanel', { extensionId: extensionId.value });
	}

	public $disposeWebview(handle: WebviewPanelHandle): void {
		const webview = this.getWebview(handle);
		webview.dispose();
	}

	public $setTitle(handle: WebviewPanelHandle, value: string): void {
		const webview = this.getWebview(handle);
		webview.setName(value);
	}

	public $setIconPath(handle: WebviewPanelHandle, value: { light: UriComponents, dark: UriComponents } | undefined): void {
		const webview = this.getWebview(handle);
		webview.iconPath = reviveWebviewIcon(value);
	}

	public $setHtml(handle: WebviewPanelHandle, value: string): void {
		const webview = this.getWebview(handle);
		webview.html = value;
	}

	public $setOptions(handle: WebviewPanelHandle, options: modes.IWebviewOptions): void {
		const webview = this.getWebview(handle);
		webview.setOptions(reviveWebviewOptions(options as any /*todo@mat */));
	}

	async $getResourceRoot(_handle: WebviewPanelHandle): Promise<string> {
		return this._environmentService.webviewResourceRoot;
	}

	public $reveal(handle: WebviewPanelHandle, showOptions: WebviewPanelShowOptions): void {
		const webview = this.getWebview(handle);
		if (webview.isDisposed()) {
			return;
		}

		const targetGroup = this._editorGroupService.getGroup(viewColumnToEditorGroup(this._editorGroupService, showOptions.viewColumn)) || this._editorGroupService.getGroup(webview.group || 0);
		if (targetGroup) {
			this._webviewService.revealWebview(webview, targetGroup, !!showOptions.preserveFocus);
		}
	}

	public async $postMessage(handle: WebviewPanelHandle, message: any): Promise<boolean> {
		const webview = this.getWebview(handle);
		const editors = this._editorService.visibleControls
			.filter(e => e instanceof WebviewEditor)
			.map(e => e as WebviewEditor)
			.filter(e => e.input!.matches(webview));

		if (editors.length > 0) {
			editors[0].sendMessage(message);
			return true;
		}

		if (webview.webview) {
			webview.webview.sendMessage(message);
			return true;
		}

		return false;
	}

	public $registerSerializer(viewType: string): void {
		if (this._revivers.has(viewType)) {
			throw new Error(`Reviver for ${viewType} already registered`);
		}

		this._revivers.set(viewType, this._webviewService.registerReviver({
			canRevive: (webview) => {
				return webview.state && webview.state.viewType === viewType;
			},
			reviveWebview: async (webview): Promise<void> => {
				const viewType = webview.state.viewType;
				const handle = 'revival-' + MainThreadWebviews.revivalPool++;
				this._webviews.set(handle, webview);
				webview._events = this.createWebviewEventDelegate(handle);
				let state = undefined;
				if (webview.state.state) {
					try {
						state = JSON.parse(webview.state.state);
					} catch {
						// noop
					}
				}

				try {
					await this._proxy.$deserializeWebviewPanel(handle, viewType, webview.getTitle(), state, editorGroupToViewColumn(this._editorGroupService, webview.group || 0), webview.options);
				} catch (error) {
					onUnexpectedError(error);
					webview.html = MainThreadWebviews.getDeserializationFailedContents(viewType);
				}
			}
		}));
	}

	public $unregisterSerializer(viewType: string): void {
		const reviver = this._revivers.get(viewType);
		if (!reviver) {
			throw new Error(`No reviver for ${viewType} registered`);
		}

		reviver.dispose();
		this._revivers.delete(viewType);
	}

	private getInternalWebviewId(viewType: string): string {
		return `mainThreadWebview-${viewType}`;
	}

	private _onBeforeShutdown(): void {
		this._webviews.forEach((webview) => {
			if (!webview.isDisposed() && webview.state && this._revivers.has(webview.state.viewType)) {
				webview.state.state = webview.webviewState;
			}
		});
	}

	private createWebviewEventDelegate(handle: WebviewPanelHandle) {
		return {
			onDidClickLink: (uri: URI) => this.onDidClickLink(handle, uri),
			onMessage: (message: any) => this._proxy.$onMessage(handle, message),
			onDispose: () => {
				this._proxy.$onDidDisposeWebviewPanel(handle).finally(() => {
					this._webviews.delete(handle);
				});
			}
		};
	}

	private onActiveEditorChanged() {
		const activeEditor = this._editorService.activeControl;
		let newActiveWebview: { input: WebviewEditorInput, handle: WebviewPanelHandle } | undefined = undefined;
		if (activeEditor && activeEditor.input instanceof WebviewEditorInput) {
			for (const handle of map.keys(this._webviews)) {
				const input = this._webviews.get(handle)!;
				if (input.matches(activeEditor.input)) {
					newActiveWebview = { input, handle };
					break;
				}
			}
		}

		if (newActiveWebview && newActiveWebview.handle === this._activeWebview) {
			// Webview itself unchanged but position may have changed
			this._proxy.$onDidChangeWebviewPanelViewState(newActiveWebview.handle, {
				active: true,
				visible: true,
				position: editorGroupToViewColumn(this._editorGroupService, newActiveWebview.input.group || 0)
			});
			return;
		}

		// Broadcast view state update for currently active
		if (typeof this._activeWebview !== 'undefined') {
			const oldActiveWebview = this._webviews.get(this._activeWebview);
			if (oldActiveWebview) {
				this._proxy.$onDidChangeWebviewPanelViewState(this._activeWebview, {
					active: false,
					visible: this._editorService.visibleControls.some(editor => !!editor.input && editor.input.matches(oldActiveWebview)),
					position: editorGroupToViewColumn(this._editorGroupService, oldActiveWebview.group || 0),
				});
			}
		}

		// Then for newly active
		if (newActiveWebview) {
			this._proxy.$onDidChangeWebviewPanelViewState(newActiveWebview.handle, {
				active: true,
				visible: true,
				position: editorGroupToViewColumn(this._editorGroupService, activeEditor ? activeEditor.group : ACTIVE_GROUP),
			});
			this._activeWebview = newActiveWebview.handle;
		} else {
			this._activeWebview = undefined;
		}
	}

	private onVisibleEditorsChanged(): void {
		this._webviews.forEach((input, handle) => {
			for (const workbenchEditor of this._editorService.visibleControls) {
				if (workbenchEditor.input && workbenchEditor.input.matches(input)) {
					const editorPosition = editorGroupToViewColumn(this._editorGroupService, workbenchEditor.group!);

					input.updateGroup(workbenchEditor.group!.id);
					this._proxy.$onDidChangeWebviewPanelViewState(handle, {
						active: handle === this._activeWebview,
						visible: true,
						position: editorPosition
					});
					break;
				}
			}
		});
	}

	private onDidClickLink(handle: WebviewPanelHandle, link: URI): void {
		if (!link) {
			return;
		}

		const webview = this.getWebview(handle);
		if (this.isSupportedLink(webview, link)) {
			this._openerService.open(link);
		}
	}

	private isSupportedLink(webview: WebviewEditorInput, link: URI): boolean {
		if (MainThreadWebviews.standardSupportedLinkSchemes.has(link.scheme)) {
			return true;
		}
		if (this._productService.urlProtocol === link.scheme) {
			return true;
		}
		return !!webview.options.enableCommandUris && link.scheme === 'command';
	}

	private getWebview(handle: WebviewPanelHandle): WebviewEditorInput {
		const webview = this._webviews.get(handle);
		if (!webview) {
			throw new Error('Unknown webview handle:' + handle);
		}
		return webview;
	}

	private static getDeserializationFailedContents(viewType: string) {
		return `<!DOCTYPE html>
		<html>
			<head>
				<base href="https://code.visualstudio.com/raw/">
				<meta http-equiv="Content-type" content="text/html;charset=UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; media-src https:; script-src 'none'; style-src vscode-resource: https: 'unsafe-inline'; child-src 'none'; frame-src 'none';">
			</head>
			<body>${localize('errorMessage', "An error occurred while restoring view:{0}", viewType)}</body>
		</html>`;
	}
}

function reviveWebviewOptions(options: WebviewInputOptions): WebviewInputOptions {
	return {
		...options,
		localResourceRoots: Array.isArray(options.localResourceRoots) ? options.localResourceRoots.map(r => URI.revive(r)) : undefined,
	};
}

function reviveWebviewIcon(
	value: { light: UriComponents, dark: UriComponents } | undefined
): { light: URI, dark: URI } | undefined {
	if (!value) {
		return undefined;
	}

	return {
		light: URI.revive(value.light),
		dark: URI.revive(value.dark)
	};
}
