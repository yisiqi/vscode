/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./links';
import * as nls from 'vs/nls';
import * as async from 'vs/base/common/async';
import { CancellationToken } from 'vs/base/common/cancellation';
import { onUnexpectedError } from 'vs/base/common/errors';
import { MarkdownString } from 'vs/base/common/htmlContent';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import * as platform from 'vs/base/common/platform';
import { ICodeEditor, MouseTargetType } from 'vs/editor/browser/editorBrowser';
import { EditorAction, ServicesAccessor, registerEditorAction, registerEditorContribution } from 'vs/editor/browser/editorExtensions';
import { Position } from 'vs/editor/common/core/position';
import * as editorCommon from 'vs/editor/common/editorCommon';
import { IModelDecorationsChangeAccessor, IModelDeltaDecoration, TrackedRangeStickiness } from 'vs/editor/common/model';
import { ModelDecorationOptions } from 'vs/editor/common/model/textModel';
import { LinkProviderRegistry } from 'vs/editor/common/modes';
import { ClickLinkGesture, ClickLinkKeyboardEvent, ClickLinkMouseEvent } from 'vs/editor/contrib/goToDefinition/clickLinkGesture';
import { Link, getLinks, LinksList } from 'vs/editor/contrib/links/getLinks';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { editorActiveLinkForeground } from 'vs/platform/theme/common/colorRegistry';
import { registerThemingParticipant } from 'vs/platform/theme/common/themeService';

const HOVER_MESSAGE_GENERAL_META = new MarkdownString().appendText(
	platform.isMacintosh
		? nls.localize('links.navigate.mac', "Follow link (cmd + click)")
		: nls.localize('links.navigate', "Follow link (ctrl + click)")
);

const HOVER_MESSAGE_COMMAND_META = new MarkdownString().appendText(
	platform.isMacintosh
		? nls.localize('links.command.mac', "Execute command (cmd + click)")
		: nls.localize('links.command', "Execute command (ctrl + click)")
);

const HOVER_MESSAGE_GENERAL_ALT = new MarkdownString().appendText(
	platform.isMacintosh
		? nls.localize('links.navigate.al.mac', "Follow link (option + click)")
		: nls.localize('links.navigate.al', "Follow link (alt + click)")
);

const HOVER_MESSAGE_COMMAND_ALT = new MarkdownString().appendText(
	platform.isMacintosh
		? nls.localize('links.command.al.mac', "Execute command (option + click)")
		: nls.localize('links.command.al', "Execute command (alt + click)")
);

const decoration = {
	meta: ModelDecorationOptions.register({
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		collapseOnReplaceEdit: true,
		inlineClassName: 'detected-link',
		hoverMessage: HOVER_MESSAGE_GENERAL_META
	}),
	metaActive: ModelDecorationOptions.register({
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		collapseOnReplaceEdit: true,
		inlineClassName: 'detected-link-active',
		hoverMessage: HOVER_MESSAGE_GENERAL_META
	}),
	alt: ModelDecorationOptions.register({
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		collapseOnReplaceEdit: true,
		inlineClassName: 'detected-link',
		hoverMessage: HOVER_MESSAGE_GENERAL_ALT
	}),
	altActive: ModelDecorationOptions.register({
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		collapseOnReplaceEdit: true,
		inlineClassName: 'detected-link-active',
		hoverMessage: HOVER_MESSAGE_GENERAL_ALT
	}),
	altCommand: ModelDecorationOptions.register({
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		collapseOnReplaceEdit: true,
		inlineClassName: 'detected-link',
		hoverMessage: HOVER_MESSAGE_COMMAND_ALT
	}),
	altCommandActive: ModelDecorationOptions.register({
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		collapseOnReplaceEdit: true,
		inlineClassName: 'detected-link-active',
		hoverMessage: HOVER_MESSAGE_COMMAND_ALT
	}),
	metaCommand: ModelDecorationOptions.register({
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		collapseOnReplaceEdit: true,
		inlineClassName: 'detected-link',
		hoverMessage: HOVER_MESSAGE_COMMAND_META
	}),
	metaCommandActive: ModelDecorationOptions.register({
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		collapseOnReplaceEdit: true,
		inlineClassName: 'detected-link-active',
		hoverMessage: HOVER_MESSAGE_COMMAND_META
	}),
};


class LinkOccurrence {

	public static decoration(link: Link, useMetaKey: boolean): IModelDeltaDecoration {
		return {
			range: link.range,
			options: LinkOccurrence._getOptions(link, useMetaKey, false)
		};
	}

	private static _getOptions(link: Link, useMetaKey: boolean, isActive: boolean): ModelDecorationOptions {
		const options = { ...this._getBaseOptions(link, useMetaKey, isActive) };
		if (typeof link.tooltip === 'string') {
			const message = new MarkdownString().appendText(
				platform.isMacintosh
					? useMetaKey
						? nls.localize('links.custom.mac', "{0} (cmd + click)", link.tooltip)
						: nls.localize('links.custom.mac.al', "{0} (option + click)", link.tooltip)
					: useMetaKey
						? nls.localize('links.custom', "{0} (ctrl + click)", link.tooltip)
						: nls.localize('links.custom.al', "{0} (alt + click)", link.tooltip)
			);
			options.hoverMessage = message;
		}
		return options;
	}

	private static _getBaseOptions(link: Link, useMetaKey: boolean, isActive: boolean): ModelDecorationOptions {
		if (link.url && /^command:/i.test(link.url.toString())) {
			if (useMetaKey) {
				return (isActive ? decoration.metaCommandActive : decoration.metaCommand);
			} else {
				return (isActive ? decoration.altCommandActive : decoration.altCommand);
			}
		} else {
			if (useMetaKey) {
				return (isActive ? decoration.metaActive : decoration.meta);
			} else {
				return (isActive ? decoration.altActive : decoration.alt);
			}
		}
	}

	public decorationId: string;
	public link: Link;

	constructor(link: Link, decorationId: string) {
		this.link = link;
		this.decorationId = decorationId;
	}

	public activate(changeAccessor: IModelDecorationsChangeAccessor, useMetaKey: boolean): void {
		changeAccessor.changeDecorationOptions(this.decorationId, LinkOccurrence._getOptions(this.link, useMetaKey, true));
	}

	public deactivate(changeAccessor: IModelDecorationsChangeAccessor, useMetaKey: boolean): void {
		changeAccessor.changeDecorationOptions(this.decorationId, LinkOccurrence._getOptions(this.link, useMetaKey, false));
	}
}

class LinkDetector implements editorCommon.IEditorContribution {

	private static readonly ID: string = 'editor.linkDetector';

	public static get(editor: ICodeEditor): LinkDetector {
		return editor.getContribution<LinkDetector>(LinkDetector.ID);
	}

	static RECOMPUTE_TIME = 1000; // ms

	private readonly editor: ICodeEditor;
	private enabled: boolean;
	private listenersToRemove: IDisposable[];
	private readonly timeout: async.TimeoutTimer;
	private computePromise: async.CancelablePromise<LinksList> | null;
	private activeLinksList: LinksList | null;
	private activeLinkDecorationId: string | null;
	private readonly openerService: IOpenerService;
	private readonly notificationService: INotificationService;
	private currentOccurrences: { [decorationId: string]: LinkOccurrence; };

	constructor(
		editor: ICodeEditor,
		@IOpenerService openerService: IOpenerService,
		@INotificationService notificationService: INotificationService
	) {
		this.editor = editor;
		this.openerService = openerService;
		this.notificationService = notificationService;
		this.listenersToRemove = [];

		let clickLinkGesture = new ClickLinkGesture(editor);
		this.listenersToRemove.push(clickLinkGesture);
		this.listenersToRemove.push(clickLinkGesture.onMouseMoveOrRelevantKeyDown(([mouseEvent, keyboardEvent]) => {
			this._onEditorMouseMove(mouseEvent, keyboardEvent);
		}));
		this.listenersToRemove.push(clickLinkGesture.onExecute((e) => {
			this.onEditorMouseUp(e);
		}));
		this.listenersToRemove.push(clickLinkGesture.onCancel((e) => {
			this.cleanUpActiveLinkDecoration();
		}));

		this.enabled = editor.getConfiguration().contribInfo.links;
		this.listenersToRemove.push(editor.onDidChangeConfiguration((e) => {
			let enabled = editor.getConfiguration().contribInfo.links;
			if (this.enabled === enabled) {
				// No change in our configuration option
				return;
			}
			this.enabled = enabled;

			// Remove any links (for the getting disabled case)
			this.updateDecorations([]);

			// Stop any computation (for the getting disabled case)
			this.stop();

			// Start computing (for the getting enabled case)
			this.beginCompute();
		}));
		this.listenersToRemove.push(editor.onDidChangeModelContent((e) => this.onChange()));
		this.listenersToRemove.push(editor.onDidChangeModel((e) => this.onModelChanged()));
		this.listenersToRemove.push(editor.onDidChangeModelLanguage((e) => this.onModelModeChanged()));
		this.listenersToRemove.push(LinkProviderRegistry.onDidChange((e) => this.onModelModeChanged()));

		this.timeout = new async.TimeoutTimer();
		this.computePromise = null;
		this.activeLinksList = null;
		this.currentOccurrences = {};
		this.activeLinkDecorationId = null;
		this.beginCompute();
	}

	public getId(): string {
		return LinkDetector.ID;
	}

	private onModelChanged(): void {
		this.currentOccurrences = {};
		this.activeLinkDecorationId = null;
		this.stop();
		this.beginCompute();
	}

	private onModelModeChanged(): void {
		this.stop();
		this.beginCompute();
	}

	private onChange(): void {
		this.timeout.setIfNotSet(() => this.beginCompute(), LinkDetector.RECOMPUTE_TIME);
	}

	private async beginCompute(): Promise<void> {
		if (!this.editor.hasModel() || !this.enabled) {
			return;
		}

		const model = this.editor.getModel();

		if (!LinkProviderRegistry.has(model)) {
			return;
		}

		if (this.activeLinksList) {
			this.activeLinksList.dispose();
			this.activeLinksList = null;
		}

		this.computePromise = async.createCancelablePromise(token => getLinks(model, token));
		try {
			this.activeLinksList = await this.computePromise;
			this.updateDecorations(this.activeLinksList.links);
		} catch (err) {
			onUnexpectedError(err);
		} finally {
			this.computePromise = null;
		}
	}

	private updateDecorations(links: Link[]): void {
		const useMetaKey = (this.editor.getConfiguration().multiCursorModifier === 'altKey');
		let oldDecorations: string[] = [];
		let keys = Object.keys(this.currentOccurrences);
		for (let i = 0, len = keys.length; i < len; i++) {
			let decorationId = keys[i];
			let occurance = this.currentOccurrences[decorationId];
			oldDecorations.push(occurance.decorationId);
		}

		let newDecorations: IModelDeltaDecoration[] = [];
		if (links) {
			// Not sure why this is sometimes null
			for (const link of links) {
				newDecorations.push(LinkOccurrence.decoration(link, useMetaKey));
			}
		}

		let decorations = this.editor.deltaDecorations(oldDecorations, newDecorations);

		this.currentOccurrences = {};
		this.activeLinkDecorationId = null;
		for (let i = 0, len = decorations.length; i < len; i++) {
			let occurance = new LinkOccurrence(links[i], decorations[i]);
			this.currentOccurrences[occurance.decorationId] = occurance;
		}
	}

	private _onEditorMouseMove(mouseEvent: ClickLinkMouseEvent, withKey: ClickLinkKeyboardEvent | null): void {
		const useMetaKey = (this.editor.getConfiguration().multiCursorModifier === 'altKey');
		if (this.isEnabled(mouseEvent, withKey)) {
			this.cleanUpActiveLinkDecoration(); // always remove previous link decoration as their can only be one
			const occurrence = this.getLinkOccurrence(mouseEvent.target.position);
			if (occurrence) {
				this.editor.changeDecorations((changeAccessor) => {
					occurrence.activate(changeAccessor, useMetaKey);
					this.activeLinkDecorationId = occurrence.decorationId;
				});
			}
		} else {
			this.cleanUpActiveLinkDecoration();
		}
	}

	private cleanUpActiveLinkDecoration(): void {
		const useMetaKey = (this.editor.getConfiguration().multiCursorModifier === 'altKey');
		if (this.activeLinkDecorationId) {
			const occurrence = this.currentOccurrences[this.activeLinkDecorationId];
			if (occurrence) {
				this.editor.changeDecorations((changeAccessor) => {
					occurrence.deactivate(changeAccessor, useMetaKey);
				});
			}

			this.activeLinkDecorationId = null;
		}
	}

	private onEditorMouseUp(mouseEvent: ClickLinkMouseEvent): void {
		if (!this.isEnabled(mouseEvent)) {
			return;
		}
		const occurrence = this.getLinkOccurrence(mouseEvent.target.position);
		if (!occurrence) {
			return;
		}
		this.openLinkOccurrence(occurrence, mouseEvent.hasSideBySideModifier);
	}

	public openLinkOccurrence(occurrence: LinkOccurrence, openToSide: boolean): void {

		if (!this.openerService) {
			return;
		}

		const { link } = occurrence;

		link.resolve(CancellationToken.None).then(uri => {
			// open the uri
			return this.openerService.open(uri, { openToSide });

		}, err => {
			// different error cases
			if (err === 'invalid') {
				this.notificationService.warn(nls.localize('invalid.url', 'Failed to open this link because it is not well-formed: {0}', link.url!.toString()));
			} else if (err === 'missing') {
				this.notificationService.warn(nls.localize('missing.url', 'Failed to open this link because its target is missing.'));
			} else {
				onUnexpectedError(err);
			}
		});
	}

	public getLinkOccurrence(position: Position | null): LinkOccurrence | null {
		if (!this.editor.hasModel() || !position) {
			return null;
		}
		const decorations = this.editor.getModel().getDecorationsInRange({
			startLineNumber: position.lineNumber,
			startColumn: position.column,
			endLineNumber: position.lineNumber,
			endColumn: position.column
		}, 0, true);

		for (const decoration of decorations) {
			const currentOccurrence = this.currentOccurrences[decoration.id];
			if (currentOccurrence) {
				return currentOccurrence;
			}
		}

		return null;
	}

	private isEnabled(mouseEvent: ClickLinkMouseEvent, withKey?: ClickLinkKeyboardEvent | null): boolean {
		return Boolean(
			(mouseEvent.target.type === MouseTargetType.CONTENT_TEXT)
			&& (mouseEvent.hasTriggerModifier || (withKey && withKey.keyCodeIsTriggerKey))
		);
	}

	private stop(): void {
		this.timeout.cancel();
		if (this.activeLinksList) {
			this.activeLinksList.dispose();
		}
		if (this.computePromise) {
			this.computePromise.cancel();
			this.computePromise = null;
		}
	}

	public dispose(): void {
		this.listenersToRemove = dispose(this.listenersToRemove);
		this.stop();
		this.timeout.dispose();
	}
}

class OpenLinkAction extends EditorAction {

	constructor() {
		super({
			id: 'editor.action.openLink',
			label: nls.localize('label', "Open Link"),
			alias: 'Open Link',
			precondition: undefined
		});
	}

	public run(accessor: ServicesAccessor, editor: ICodeEditor): void {
		let linkDetector = LinkDetector.get(editor);
		if (!linkDetector) {
			return;
		}
		if (!editor.hasModel()) {
			return;
		}

		let selections = editor.getSelections();

		for (let sel of selections) {
			let link = linkDetector.getLinkOccurrence(sel.getEndPosition());

			if (link) {
				linkDetector.openLinkOccurrence(link, false);
			}
		}
	}
}

registerEditorContribution(LinkDetector);
registerEditorAction(OpenLinkAction);

registerThemingParticipant((theme, collector) => {
	const activeLinkForeground = theme.getColor(editorActiveLinkForeground);
	if (activeLinkForeground) {
		collector.addRule(`.monaco-editor .detected-link-active { color: ${activeLinkForeground} !important; }`);
	}
});
