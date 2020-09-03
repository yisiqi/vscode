/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from 'vs/base/common/async';
import { CancellationTokenSource } from 'vs/base/common/cancellation';
import * as errors from 'vs/base/common/errors';
import { Emitter, Event } from 'vs/base/common/event';
import { getBaseLabel } from 'vs/base/common/labels';
import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import { ResourceMap, TernarySearchTree, values } from 'vs/base/common/map';
import * as objects from 'vs/base/common/objects';
import { lcut } from 'vs/base/common/strings';
import { URI } from 'vs/base/common/uri';
import { Range } from 'vs/editor/common/core/range';
import { FindMatch, IModelDeltaDecoration, ITextModel, OverviewRulerLane, TrackedRangeStickiness } from 'vs/editor/common/model';
import { ModelDecorationOptions } from 'vs/editor/common/model/textModel';
import { IModelService } from 'vs/editor/common/services/modelService';
import { createDecorator, IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IProgress, IProgressStep } from 'vs/platform/progress/common/progress';
import { ReplacePattern } from 'vs/workbench/services/search/common/replace';
import { IFileMatch, IPatternInfo, ISearchComplete, ISearchProgressItem, ISearchService, ITextQuery, ITextSearchPreviewOptions, ITextSearchMatch, ITextSearchStats, resultIsMatch, ISearchRange, OneLineRange } from 'vs/workbench/services/search/common/search';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { overviewRulerFindMatchForeground } from 'vs/platform/theme/common/colorRegistry';
import { themeColorFromId } from 'vs/platform/theme/common/themeService';
import { IReplaceService } from 'vs/workbench/contrib/search/common/replace';
import { editorMatchesToTextSearchResults } from 'vs/workbench/services/search/common/searchHelpers';
import { withNullAsUndefined } from 'vs/base/common/types';

export class Match {

	private static readonly MAX_PREVIEW_CHARS = 250;

	private _id: string;
	private _range: Range;
	private _oneLinePreviewText: string;
	private _rangeInPreviewText: ISearchRange;

	// For replace
	private _fullPreviewRange: ISearchRange;

	constructor(private _parent: FileMatch, private _fullPreviewLines: string[], _fullPreviewRange: ISearchRange, _documentRange: ISearchRange) {
		this._oneLinePreviewText = _fullPreviewLines[_fullPreviewRange.startLineNumber];
		const adjustedEndCol = _fullPreviewRange.startLineNumber === _fullPreviewRange.endLineNumber ?
			_fullPreviewRange.endColumn :
			this._oneLinePreviewText.length;
		this._rangeInPreviewText = new OneLineRange(1, _fullPreviewRange.startColumn + 1, adjustedEndCol + 1);

		this._range = new Range(
			_documentRange.startLineNumber + 1,
			_documentRange.startColumn + 1,
			_documentRange.endLineNumber + 1,
			_documentRange.endColumn + 1);

		this._fullPreviewRange = _fullPreviewRange;

		this._id = this._parent.id() + '>' + this._range + this.getMatchString();
	}

	id(): string {
		return this._id;
	}

	parent(): FileMatch {
		return this._parent;
	}

	text(): string {
		return this._oneLinePreviewText;
	}

	range(): Range {
		return this._range;
	}

	preview(): { before: string; inside: string; after: string; } {
		let before = this._oneLinePreviewText.substring(0, this._rangeInPreviewText.startColumn - 1),
			inside = this.getMatchString(),
			after = this._oneLinePreviewText.substring(this._rangeInPreviewText.endColumn - 1);

		before = lcut(before, 26);
		before = before.trimLeft();

		let charsRemaining = Match.MAX_PREVIEW_CHARS - before.length;
		inside = inside.substr(0, charsRemaining);
		charsRemaining -= inside.length;
		after = after.substr(0, charsRemaining);

		return {
			before,
			inside,
			after,
		};
	}

	get replaceString(): string {
		const searchModel = this.parent().parent().searchModel;
		if (!searchModel.replacePattern) {
			throw new Error('searchModel.replacePattern must be set before accessing replaceString');
		}

		const fullMatchText = this.fullMatchText();
		let replaceString = searchModel.replacePattern.getReplaceString(fullMatchText);

		// If match string is not matching then regex pattern has a lookahead expression
		if (replaceString === null) {
			const fullMatchTextWithTrailingContent = this.fullMatchText(true);
			replaceString = searchModel.replacePattern.getReplaceString(fullMatchTextWithTrailingContent);

			// Search/find normalize line endings - check whether \r prevents regex from matching
			if (replaceString === null) {
				const fullMatchTextWithoutCR = fullMatchTextWithTrailingContent.replace(/\r\n/g, '\n');
				replaceString = searchModel.replacePattern.getReplaceString(fullMatchTextWithoutCR);
			}
		}

		// Match string is still not matching. Could be unsupported matches (multi-line).
		if (replaceString === null) {
			replaceString = searchModel.replacePattern.pattern;
		}

		return replaceString;
	}

	fullMatchText(includeTrailing = false): string {
		let thisMatchPreviewLines: string[];
		if (includeTrailing) {
			thisMatchPreviewLines = this._fullPreviewLines.slice(this._fullPreviewRange.startLineNumber);
		} else {
			thisMatchPreviewLines = this._fullPreviewLines.slice(this._fullPreviewRange.startLineNumber, this._fullPreviewRange.endLineNumber + 1);
			thisMatchPreviewLines[thisMatchPreviewLines.length - 1] = thisMatchPreviewLines[thisMatchPreviewLines.length - 1].slice(0, this._fullPreviewRange.endColumn);

		}

		thisMatchPreviewLines[0] = thisMatchPreviewLines[0].slice(this._fullPreviewRange.startColumn);
		return thisMatchPreviewLines.join('\n');
	}

	fullPreviewLines(): string[] {
		return this._fullPreviewLines.slice(this._fullPreviewRange.startLineNumber, this._fullPreviewRange.endLineNumber + 1);
	}

	getMatchString(): string {
		return this._oneLinePreviewText.substring(this._rangeInPreviewText.startColumn - 1, this._rangeInPreviewText.endColumn - 1);
	}
}

export class FileMatch extends Disposable {

	private static readonly _CURRENT_FIND_MATCH = ModelDecorationOptions.register({
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		zIndex: 13,
		className: 'currentFindMatch',
		overviewRuler: {
			color: themeColorFromId(overviewRulerFindMatchForeground),
			position: OverviewRulerLane.Center
		}
	});

	private static readonly _FIND_MATCH = ModelDecorationOptions.register({
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		className: 'findMatch',
		overviewRuler: {
			color: themeColorFromId(overviewRulerFindMatchForeground),
			position: OverviewRulerLane.Center
		}
	});

	private static getDecorationOption(selected: boolean): ModelDecorationOptions {
		return (selected ? FileMatch._CURRENT_FIND_MATCH : FileMatch._FIND_MATCH);
	}

	private _onChange = this._register(new Emitter<boolean>());
	readonly onChange: Event<boolean> = this._onChange.event;

	private _onDispose = this._register(new Emitter<void>());
	readonly onDispose: Event<void> = this._onDispose.event;

	private _resource: URI;
	private _model: ITextModel | null;
	private _modelListener: IDisposable;
	private _matches: Map<string, Match>;
	private _removedMatches: Set<string>;
	private _selectedMatch: Match | null;

	private _updateScheduler: RunOnceScheduler;
	private _modelDecorations: string[] = [];

	constructor(private _query: IPatternInfo, private _previewOptions: ITextSearchPreviewOptions, private _maxResults: number, private _parent: BaseFolderMatch, private rawMatch: IFileMatch,
		@IModelService private readonly modelService: IModelService, @IReplaceService private readonly replaceService: IReplaceService
	) {
		super();
		this._resource = this.rawMatch.resource;
		this._matches = new Map<string, Match>();
		this._removedMatches = new Set<string>();
		this._updateScheduler = new RunOnceScheduler(this.updateMatchesForModel.bind(this), 250);

		this.createMatches();
	}

	private createMatches(): void {
		const model = this.modelService.getModel(this._resource);
		if (model) {
			this.bindModel(model);
			this.updateMatchesForModel();
		} else {
			this.rawMatch.results!
				.filter(resultIsMatch)
				.forEach(rawMatch => {
					textSearchResultToMatches(rawMatch, this)
						.forEach(m => this.add(m));
				});
		}
	}

	bindModel(model: ITextModel): void {
		this._model = model;
		this._modelListener = this._model.onDidChangeContent(() => {
			this._updateScheduler.schedule();
		});
		this._model.onWillDispose(() => this.onModelWillDispose());
		this.updateHighlights();
	}

	private onModelWillDispose(): void {
		// Update matches because model might have some dirty changes
		this.updateMatchesForModel();
		this.unbindModel();
	}

	private unbindModel(): void {
		if (this._model) {
			this._updateScheduler.cancel();
			this._model.deltaDecorations(this._modelDecorations, []);
			this._model = null;
			this._modelListener.dispose();
		}
	}

	private updateMatchesForModel(): void {
		// this is called from a timeout and might fire
		// after the model has been disposed
		if (!this._model) {
			return;
		}
		this._matches = new Map<string, Match>();

		const wordSeparators = this._query.isWordMatch && this._query.wordSeparators ? this._query.wordSeparators : null;
		const matches = this._model
			.findMatches(this._query.pattern, this._model.getFullModelRange(), !!this._query.isRegExp, !!this._query.isCaseSensitive, wordSeparators, false, this._maxResults);

		this.updateMatches(matches, true);
	}

	private updatesMatchesForLineAfterReplace(lineNumber: number, modelChange: boolean): void {
		if (!this._model) {
			return;
		}

		const range = {
			startLineNumber: lineNumber,
			startColumn: this._model.getLineMinColumn(lineNumber),
			endLineNumber: lineNumber,
			endColumn: this._model.getLineMaxColumn(lineNumber)
		};
		const oldMatches = values(this._matches).filter(match => match.range().startLineNumber === lineNumber);
		oldMatches.forEach(match => this._matches.delete(match.id()));

		const wordSeparators = this._query.isWordMatch && this._query.wordSeparators ? this._query.wordSeparators : null;
		const matches = this._model.findMatches(this._query.pattern, range, !!this._query.isRegExp, !!this._query.isCaseSensitive, wordSeparators, false, this._maxResults);
		this.updateMatches(matches, modelChange);
	}

	private updateMatches(matches: FindMatch[], modelChange: boolean): void {
		if (!this._model) {
			return;
		}

		const textSearchResults = editorMatchesToTextSearchResults(matches, this._model, this._previewOptions);
		textSearchResults.forEach(textSearchResult => {
			textSearchResultToMatches(textSearchResult, this).forEach(match => {
				if (!this._removedMatches.has(match.id())) {
					this.add(match);
					if (this.isMatchSelected(match)) {
						this._selectedMatch = match;
					}
				}
			});
		});

		this._onChange.fire(modelChange);
		this.updateHighlights();
	}

	updateHighlights(): void {
		if (!this._model) {
			return;
		}

		if (this.parent().showHighlights) {
			this._modelDecorations = this._model.deltaDecorations(this._modelDecorations, this.matches().map(match => <IModelDeltaDecoration>{
				range: match.range(),
				options: FileMatch.getDecorationOption(this.isMatchSelected(match))
			}));
		} else {
			this._modelDecorations = this._model.deltaDecorations(this._modelDecorations, []);
		}
	}

	id(): string {
		return this.resource().toString();
	}

	parent(): BaseFolderMatch {
		return this._parent;
	}

	matches(): Match[] {
		return values(this._matches);
	}

	remove(match: Match): void {
		this.removeMatch(match);
		this._removedMatches.add(match.id());
		this._onChange.fire(false);
	}

	replace(toReplace: Match): Promise<void> {
		return this.replaceService.replace(toReplace)
			.then(() => this.updatesMatchesForLineAfterReplace(toReplace.range().startLineNumber, false));
	}

	setSelectedMatch(match: Match | null): void {
		if (match) {
			if (!this._matches.has(match.id())) {
				return;
			}
			if (this.isMatchSelected(match)) {
				return;
			}
		}

		this._selectedMatch = match;
		this.updateHighlights();
	}

	getSelectedMatch(): Match | null {
		return this._selectedMatch;
	}

	isMatchSelected(match: Match): boolean {
		return !!this._selectedMatch && this._selectedMatch.id() === match.id();
	}

	count(): number {
		return this.matches().length;
	}

	resource(): URI {
		return this._resource;
	}

	name(): string {
		return getBaseLabel(this.resource());
	}

	add(match: Match, trigger?: boolean) {
		this._matches.set(match.id(), match);
		if (trigger) {
			this._onChange.fire(true);
		}
	}

	private removeMatch(match: Match) {
		this._matches.delete(match.id());
		if (this.isMatchSelected(match)) {
			this.setSelectedMatch(null);
		} else {
			this.updateHighlights();
		}
	}

	dispose(): void {
		this.setSelectedMatch(null);
		this.unbindModel();
		this._onDispose.fire();
		super.dispose();
	}
}

export interface IChangeEvent {
	elements: (FileMatch | FolderMatch | SearchResult)[];
	added?: boolean;
	removed?: boolean;
}

export class BaseFolderMatch extends Disposable {

	private _onChange = this._register(new Emitter<IChangeEvent>());
	readonly onChange: Event<IChangeEvent> = this._onChange.event;

	private _onDispose = this._register(new Emitter<void>());
	readonly onDispose: Event<void> = this._onDispose.event;

	private _fileMatches: ResourceMap<FileMatch>;
	private _unDisposedFileMatches: ResourceMap<FileMatch>;
	private _replacingAll: boolean = false;

	constructor(protected _resource: URI | null, private _id: string, private _index: number, private _query: ITextQuery, private _parent: SearchResult, private _searchModel: SearchModel,
		@IReplaceService private readonly replaceService: IReplaceService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super();
		this._fileMatches = new ResourceMap<FileMatch>();
		this._unDisposedFileMatches = new ResourceMap<FileMatch>();
	}

	get searchModel(): SearchModel {
		return this._searchModel;
	}

	get showHighlights(): boolean {
		return this._parent.showHighlights;
	}

	set replacingAll(b: boolean) {
		this._replacingAll = b;
	}

	id(): string {
		return this._id;
	}

	resource(): URI | null {
		return this._resource;
	}

	index(): number {
		return this._index;
	}

	name(): string {
		return getBaseLabel(withNullAsUndefined(this.resource())) || '';
	}

	parent(): SearchResult {
		return this._parent;
	}

	hasResource(): boolean {
		return !!this._resource;
	}

	bindModel(model: ITextModel): void {
		const fileMatch = this._fileMatches.get(model.uri);
		if (fileMatch) {
			fileMatch.bindModel(model);
		}
	}

	add(raw: IFileMatch[], silent: boolean): void {
		const added: FileMatch[] = [];
		const updated: FileMatch[] = [];
		raw.forEach(rawFileMatch => {
			const existingFileMatch = this._fileMatches.get(rawFileMatch.resource);
			if (existingFileMatch) {
				rawFileMatch
					.results!
					.filter(resultIsMatch)
					.forEach(m => {
						textSearchResultToMatches(m, existingFileMatch)
							.forEach(m => existingFileMatch.add(m));
					});
				updated.push(existingFileMatch);
			} else {
				const fileMatch = this.instantiationService.createInstance(FileMatch, this._query.contentPattern, this._query.previewOptions, this._query.maxResults, this, rawFileMatch);
				this.doAdd(fileMatch);
				added.push(fileMatch);
				const disposable = fileMatch.onChange(() => this.onFileChange(fileMatch));
				fileMatch.onDispose(() => disposable.dispose());
			}
		});

		const elements = [...added, ...updated];
		if (!silent && elements.length) {
			this._onChange.fire({ elements, added: !!added.length });
		}
	}

	clear(): void {
		const changed: FileMatch[] = this.matches();
		this.disposeMatches();
		this._onChange.fire({ elements: changed, removed: true });
	}

	remove(match: FileMatch): void {
		this.doRemove(match);
	}

	replace(match: FileMatch): Promise<any> {
		return this.replaceService.replace([match]).then(() => {
			this.doRemove(match, false, true);
		});
	}

	replaceAll(): Promise<any> {
		const matches = this.matches();
		return this.replaceService.replace(matches).then(() => {
			matches.forEach(match => this.doRemove(match, false, true));
		});
	}

	matches(): FileMatch[] {
		return this._fileMatches.values();
	}

	isEmpty(): boolean {
		return this.fileCount() === 0;
	}

	fileCount(): number {
		return this._fileMatches.size;
	}

	count(): number {
		return this.matches().reduce<number>((prev, match) => prev + match.count(), 0);
	}

	private onFileChange(fileMatch: FileMatch): void {
		let added: boolean = false;
		let removed: boolean = false;
		if (!this._fileMatches.has(fileMatch.resource())) {
			this.doAdd(fileMatch);
			added = true;
		}
		if (fileMatch.count() === 0) {
			this.doRemove(fileMatch, false, false);
			added = false;
			removed = true;
		}
		if (!this._replacingAll) {
			this._onChange.fire({ elements: [fileMatch], added: added, removed: removed });
		}
	}

	private doAdd(fileMatch: FileMatch): void {
		this._fileMatches.set(fileMatch.resource(), fileMatch);
		if (this._unDisposedFileMatches.has(fileMatch.resource())) {
			this._unDisposedFileMatches.delete(fileMatch.resource());
		}
	}

	private doRemove(fileMatch: FileMatch, dispose: boolean = true, trigger: boolean = true): void {
		this._fileMatches.delete(fileMatch.resource());
		if (dispose) {
			fileMatch.dispose();
		} else {
			this._unDisposedFileMatches.set(fileMatch.resource(), fileMatch);
		}

		if (trigger) {
			this._onChange.fire({ elements: [fileMatch], removed: true });
		}
	}

	private disposeMatches(): void {
		this._fileMatches.values().forEach((fileMatch: FileMatch) => fileMatch.dispose());
		this._unDisposedFileMatches.values().forEach((fileMatch: FileMatch) => fileMatch.dispose());
		this._fileMatches.clear();
		this._unDisposedFileMatches.clear();
	}

	dispose(): void {
		this.disposeMatches();
		this._onDispose.fire();
		super.dispose();
	}
}

/**
 * BaseFolderMatch => optional resource ("other files" node)
 * FolderMatch => required resource (normal folder node)
 */
export class FolderMatch extends BaseFolderMatch {
	constructor(_resource: URI, _id: string, _index: number, _query: ITextQuery, _parent: SearchResult, _searchModel: SearchModel,
		@IReplaceService replaceService: IReplaceService,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super(_resource, _id, _index, _query, _parent, _searchModel, replaceService, instantiationService);
	}

	resource(): URI {
		return this._resource!;
	}
}

/**
 * Compares instances of the same match type. Different match types should not be siblings
 * and their sort order is undefined.
 */
export function searchMatchComparer(elementA: RenderableMatch, elementB: RenderableMatch): number {
	if (elementA instanceof BaseFolderMatch && elementB instanceof BaseFolderMatch) {
		return elementA.index() - elementB.index();
	}

	if (elementA instanceof FileMatch && elementB instanceof FileMatch) {
		return elementA.resource().fsPath.localeCompare(elementB.resource().fsPath) || elementA.name().localeCompare(elementB.name());
	}

	if (elementA instanceof Match && elementB instanceof Match) {
		return Range.compareRangesUsingStarts(elementA.range(), elementB.range());
	}

	return 0;
}

export class SearchResult extends Disposable {

	private _onChange = this._register(new Emitter<IChangeEvent>());
	readonly onChange: Event<IChangeEvent> = this._onChange.event;

	private _folderMatches: FolderMatch[] = [];
	private _otherFilesMatch: BaseFolderMatch;
	private _folderMatchesMap: TernarySearchTree<FolderMatch> = TernarySearchTree.forPaths<FolderMatch>();
	private _showHighlights: boolean;
	private _query: ITextQuery;

	private _rangeHighlightDecorations: RangeHighlightDecorations;

	constructor(
		private _searchModel: SearchModel,
		@IReplaceService private readonly replaceService: IReplaceService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IModelService private readonly modelService: IModelService,
	) {
		super();
		this._rangeHighlightDecorations = this.instantiationService.createInstance(RangeHighlightDecorations);

		this._register(this.modelService.onModelAdded(model => this.onModelAdded(model)));
	}

	get query(): ITextQuery {
		return this._query;
	}

	set query(query: ITextQuery) {
		// When updating the query we could change the roots, so ensure we clean up the old roots first.
		this.clear();
		this._folderMatches = (query.folderQueries || [])
			.map(fq => fq.folder)
			.map((resource, index) => this.createFolderMatch(resource, resource.toString(), index, query));

		this._folderMatches.forEach(fm => this._folderMatchesMap.set(fm.resource().toString(), fm));
		this._otherFilesMatch = this.createOtherFilesFolderMatch('otherFiles', this._folderMatches.length + 1, query);

		this._query = query;
	}

	private onModelAdded(model: ITextModel): void {
		const folderMatch = this._folderMatchesMap.findSubstr(model.uri.toString());
		if (folderMatch) {
			folderMatch.bindModel(model);
		}
	}

	private createFolderMatch(resource: URI, id: string, index: number, query: ITextQuery): FolderMatch {
		return <FolderMatch>this._createBaseFolderMatch(FolderMatch, resource, id, index, query);
	}

	private createOtherFilesFolderMatch(id: string, index: number, query: ITextQuery): BaseFolderMatch {
		return this._createBaseFolderMatch(BaseFolderMatch, null, id, index, query);
	}

	private _createBaseFolderMatch(folderMatchClass: typeof BaseFolderMatch | typeof FolderMatch, resource: URI | null, id: string, index: number, query: ITextQuery): BaseFolderMatch {
		const folderMatch = this.instantiationService.createInstance(folderMatchClass, resource, id, index, query, this, this._searchModel);
		const disposable = folderMatch.onChange((event) => this._onChange.fire(event));
		folderMatch.onDispose(() => disposable.dispose());
		return folderMatch;
	}

	get searchModel(): SearchModel {
		return this._searchModel;
	}

	add(allRaw: IFileMatch[], silent: boolean = false): void {
		// Split up raw into a list per folder so we can do a batch add per folder.
		const rawPerFolder = new ResourceMap<IFileMatch[]>();
		const otherFileMatches: IFileMatch[] = [];
		this._folderMatches.forEach(fm => rawPerFolder.set(fm.resource(), []));

		allRaw.forEach(rawFileMatch => {
			const folderMatch = this.getFolderMatch(rawFileMatch.resource);
			if (!folderMatch) {
				// foldermatch was previously removed by user or disposed for some reason
				return;
			}

			const resource = folderMatch.resource();
			if (resource) {
				rawPerFolder.get(resource)!.push(rawFileMatch);
			} else {
				otherFileMatches.push(rawFileMatch);
			}
		});

		rawPerFolder.forEach((raw) => {
			if (!raw.length) {
				return;
			}

			const folderMatch = this.getFolderMatch(raw[0].resource);
			if (folderMatch) {
				folderMatch.add(raw, silent);
			}
		});

		this._otherFilesMatch!.add(otherFileMatches, silent);
	}

	clear(): void {
		this.folderMatches().forEach((folderMatch) => folderMatch.clear());
		this.disposeMatches();
	}

	remove(match: FileMatch | FolderMatch): void {
		if (match instanceof FileMatch) {
			this.getFolderMatch(match.resource()).remove(match);
		} else {
			match.clear();
		}
	}

	replace(match: FileMatch): Promise<any> {
		return this.getFolderMatch(match.resource()).replace(match);
	}

	replaceAll(progress: IProgress<IProgressStep>): Promise<any> {
		this.replacingAll = true;

		const promise = this.replaceService.replace(this.matches(), progress);
		const onDone = Event.stopwatch(Event.fromPromise(promise));
		/* __GDPR__
			"replaceAll.started" : {
				"duration" : { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true }
			}
		*/
		onDone(duration => this.telemetryService.publicLog('replaceAll.started', { duration }));

		return promise.then(() => {
			this.replacingAll = false;
			this.clear();
		}, () => {
			this.replacingAll = false;
		});
	}

	folderMatches(): BaseFolderMatch[] {
		return this._otherFilesMatch ?
			[
				...this._folderMatches,
				this._otherFilesMatch
			] :
			[
				...this._folderMatches
			];
	}

	matches(): FileMatch[] {
		const matches: FileMatch[][] = [];
		this.folderMatches().forEach(folderMatch => {
			matches.push(folderMatch.matches());
		});

		return (<FileMatch[]>[]).concat(...matches);
	}

	isEmpty(): boolean {
		return this.folderMatches().every((folderMatch) => folderMatch.isEmpty());
	}

	fileCount(): number {
		return this.folderMatches().reduce<number>((prev, match) => prev + match.fileCount(), 0);
	}

	count(): number {
		return this.matches().reduce<number>((prev, match) => prev + match.count(), 0);
	}

	get showHighlights(): boolean {
		return this._showHighlights;
	}

	toggleHighlights(value: boolean): void {
		if (this._showHighlights === value) {
			return;
		}
		this._showHighlights = value;
		let selectedMatch: Match | null = null;
		this.matches().forEach((fileMatch: FileMatch) => {
			fileMatch.updateHighlights();
			if (!selectedMatch) {
				selectedMatch = fileMatch.getSelectedMatch();
			}
		});
		if (this._showHighlights && selectedMatch) {
			// TS?
			this._rangeHighlightDecorations.highlightRange(
				(<Match>selectedMatch).parent().resource(),
				(<Match>selectedMatch).range()
			);
		} else {
			this._rangeHighlightDecorations.removeHighlightRange();
		}
	}

	get rangeHighlightDecorations(): RangeHighlightDecorations {
		return this._rangeHighlightDecorations;
	}

	private getFolderMatch(resource: URI): BaseFolderMatch {
		const folderMatch = this._folderMatchesMap.findSubstr(resource.toString());
		return folderMatch ? folderMatch : this._otherFilesMatch;
	}

	private set replacingAll(running: boolean) {
		this.folderMatches().forEach((folderMatch) => {
			folderMatch.replacingAll = running;
		});
	}

	private disposeMatches(): void {
		this.folderMatches().forEach(folderMatch => folderMatch.dispose());
		this._folderMatches = [];
		this._folderMatchesMap = TernarySearchTree.forPaths<FolderMatch>();
		this._rangeHighlightDecorations.removeHighlightRange();
	}

	dispose(): void {
		this.disposeMatches();
		this._rangeHighlightDecorations.dispose();
		super.dispose();
	}
}

export class SearchModel extends Disposable {

	private _searchResult: SearchResult;
	private _searchQuery: ITextQuery | null = null;
	private _replaceActive: boolean = false;
	private _replaceString: string | null = null;
	private _replacePattern: ReplacePattern | null = null;

	private readonly _onReplaceTermChanged: Emitter<void> = this._register(new Emitter<void>());
	readonly onReplaceTermChanged: Event<void> = this._onReplaceTermChanged.event;

	private currentCancelTokenSource: CancellationTokenSource;

	constructor(
		@ISearchService private readonly searchService: ISearchService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super();
		this._searchResult = this.instantiationService.createInstance(SearchResult, this);
	}

	isReplaceActive(): boolean {
		return this._replaceActive;
	}

	set replaceActive(replaceActive: boolean) {
		this._replaceActive = replaceActive;
	}

	get replacePattern(): ReplacePattern | null {
		return this._replacePattern;
	}

	get replaceString(): string {
		return this._replaceString || '';
	}

	set replaceString(replaceString: string) {
		this._replaceString = replaceString;
		if (this._searchQuery) {
			this._replacePattern = new ReplacePattern(replaceString, this._searchQuery.contentPattern);
		}
		this._onReplaceTermChanged.fire();
	}

	get searchResult(): SearchResult {
		return this._searchResult;
	}

	search(query: ITextQuery, onProgress?: (result: ISearchProgressItem) => void): Promise<ISearchComplete> {
		this.cancelSearch();

		this._searchQuery = query;
		this.searchResult.clear();
		this._searchResult.query = this._searchQuery;

		const progressEmitter = new Emitter<void>();
		this._replacePattern = new ReplacePattern(this.replaceString, this._searchQuery.contentPattern);

		const tokenSource = this.currentCancelTokenSource = new CancellationTokenSource();
		const currentRequest = this.searchService.textSearch(this._searchQuery, this.currentCancelTokenSource.token, p => {
			progressEmitter.fire();
			this.onSearchProgress(p);

			if (onProgress) {
				onProgress(p);
			}
		});

		const dispose = () => tokenSource.dispose();
		currentRequest.then(dispose, dispose);

		const onDone = Event.fromPromise(currentRequest);
		const onFirstRender = Event.any<any>(onDone, progressEmitter.event);
		const onFirstRenderStopwatch = Event.stopwatch(onFirstRender);
		/* __GDPR__
			"searchResultsFirstRender" : {
				"duration" : { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true }
			}
		*/
		onFirstRenderStopwatch(duration => this.telemetryService.publicLog('searchResultsFirstRender', { duration }));

		const onDoneStopwatch = Event.stopwatch(onDone);
		const start = Date.now();

		/* __GDPR__
			"searchResultsFinished" : {
				"duration" : { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true }
			}
		*/
		onDoneStopwatch(duration => this.telemetryService.publicLog('searchResultsFinished', { duration }));

		currentRequest.then(
			value => this.onSearchCompleted(value, Date.now() - start),
			e => this.onSearchError(e, Date.now() - start));

		return currentRequest;
	}

	private onSearchCompleted(completed: ISearchComplete | null, duration: number): ISearchComplete | null {
		if (!this._searchQuery) {
			throw new Error('onSearchCompleted must be called after a search is started');
		}

		const options: IPatternInfo = objects.assign({}, this._searchQuery.contentPattern);
		delete options.pattern;

		const stats = completed && completed.stats as ITextSearchStats;

		const fileSchemeOnly = this._searchQuery.folderQueries.every(fq => fq.folder.scheme === 'file');
		const otherSchemeOnly = this._searchQuery.folderQueries.every(fq => fq.folder.scheme !== 'file');
		const scheme = fileSchemeOnly ? 'file' :
			otherSchemeOnly ? 'other' :
				'mixed';

		/* __GDPR__
			"searchResultsShown" : {
				"count" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
				"fileCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
				"options": { "${inline}": [ "${IPatternInfo}" ] },
				"duration": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true },
				"type" : { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" },
				"scheme" : { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" }
			}
		*/
		this.telemetryService.publicLog('searchResultsShown', {
			count: this._searchResult.count(),
			fileCount: this._searchResult.fileCount(),
			options,
			duration,
			type: stats && stats.type,
			scheme
		});
		return completed;
	}

	private onSearchError(e: any, duration: number): void {
		if (errors.isPromiseCanceledError(e)) {
			this.onSearchCompleted(null, duration);
		}
	}

	private onSearchProgress(p: ISearchProgressItem): void {
		if ((<IFileMatch>p).resource) {
			this._searchResult.add([<IFileMatch>p], true);
		}
	}

	cancelSearch(): boolean {
		if (this.currentCancelTokenSource) {
			this.currentCancelTokenSource.cancel();
			return true;
		}
		return false;
	}

	dispose(): void {
		this.cancelSearch();
		this.searchResult.dispose();
		super.dispose();
	}
}

export type FileMatchOrMatch = FileMatch | Match;

export type RenderableMatch = BaseFolderMatch | FolderMatch | FileMatch | Match;

export class SearchWorkbenchService implements ISearchWorkbenchService {

	_serviceBrand: any;
	private _searchModel: SearchModel;

	constructor(@IInstantiationService private readonly instantiationService: IInstantiationService) {
	}

	get searchModel(): SearchModel {
		if (!this._searchModel) {
			this._searchModel = this.instantiationService.createInstance(SearchModel);
		}
		return this._searchModel;
	}
}

export const ISearchWorkbenchService = createDecorator<ISearchWorkbenchService>('searchWorkbenchService');

export interface ISearchWorkbenchService {
	_serviceBrand: any;

	readonly searchModel: SearchModel;
}

/**
 * Can add a range highlight decoration to a model.
 * It will automatically remove it when the model has its decorations changed.
 */
export class RangeHighlightDecorations implements IDisposable {

	private _decorationId: string | null = null;
	private _model: ITextModel | null = null;
	private _modelDisposables: IDisposable[] = [];

	constructor(
		@IModelService private readonly _modelService: IModelService
	) {
	}

	removeHighlightRange() {
		if (this._model && this._decorationId) {
			this._model.deltaDecorations([this._decorationId], []);
		}
		this._decorationId = null;
	}

	highlightRange(resource: URI | ITextModel, range: Range, ownerId: number = 0): void {
		let model: ITextModel | null;
		if (URI.isUri(resource)) {
			model = this._modelService.getModel(resource);
		} else {
			model = resource;
		}

		if (model) {
			this.doHighlightRange(model, range);
		}
	}

	private doHighlightRange(model: ITextModel, range: Range) {
		this.removeHighlightRange();
		this._decorationId = model.deltaDecorations([], [{ range: range, options: RangeHighlightDecorations._RANGE_HIGHLIGHT_DECORATION }])[0];
		this.setModel(model);
	}

	private setModel(model: ITextModel) {
		if (this._model !== model) {
			this.disposeModelListeners();
			this._model = model;
			this._modelDisposables.push(this._model.onDidChangeDecorations((e) => {
				this.disposeModelListeners();
				this.removeHighlightRange();
				this._model = null;
			}));
			this._modelDisposables.push(this._model.onWillDispose(() => {
				this.disposeModelListeners();
				this.removeHighlightRange();
				this._model = null;
			}));
		}
	}

	private disposeModelListeners() {
		this._modelDisposables.forEach(disposable => disposable.dispose());
		this._modelDisposables = [];
	}

	dispose() {
		if (this._model) {
			this.removeHighlightRange();
			this.disposeModelListeners();
			this._model = null;
		}
	}

	private static readonly _RANGE_HIGHLIGHT_DECORATION = ModelDecorationOptions.register({
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		className: 'rangeHighlight',
		isWholeLine: true
	});
}

function textSearchResultToMatches(rawMatch: ITextSearchMatch, fileMatch: FileMatch): Match[] {
	const previewLines = rawMatch.preview.text.split('\n');
	if (Array.isArray(rawMatch.ranges)) {
		return rawMatch.ranges.map((r, i) => {
			const previewRange: ISearchRange = rawMatch.preview.matches[i];
			return new Match(fileMatch, previewLines, previewRange, r);
		});
	} else {
		const previewRange = <ISearchRange>rawMatch.preview.matches;
		const match = new Match(fileMatch, previewLines, previewRange, rawMatch.ranges);
		return [match];
	}
}
