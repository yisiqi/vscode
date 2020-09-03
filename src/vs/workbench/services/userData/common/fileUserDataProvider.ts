/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import { IUserDataProvider } from 'vs/workbench/services/userData/common/userData';
import { IFileService, FileChangesEvent } from 'vs/platform/files/common/files';
import { URI } from 'vs/base/common/uri';
import * as resources from 'vs/base/common/resources';
import { VSBuffer } from 'vs/base/common/buffer';
import { startsWith } from 'vs/base/common/strings';

export class FileUserDataProvider extends Disposable implements IUserDataProvider {

	private _onDidChangeFile: Emitter<string[]> = this._register(new Emitter<string[]>());
	readonly onDidChangeFile: Event<string[]> = this._onDidChangeFile.event;

	constructor(
		private readonly userDataHome: URI,
		@IFileService private readonly fileService: IFileService
	) {
		super();
		// Assumption: This path always exists
		this.fileService.watch(this.userDataHome);

		this._register(this.fileService.onFileChanges(e => this.handleFileChanges(e)));
	}

	private handleFileChanges(event: FileChangesEvent): void {
		const changedPaths: string[] = [];
		for (const change of event.changes) {
			if (change.resource.scheme === this.userDataHome.scheme) {
				const path = this.toPath(change.resource);
				if (path) {
					changedPaths.push(path);
				}
			}
		}
		if (changedPaths.length) {
			this._onDidChangeFile.fire(changedPaths);
		}
	}

	async readFile(path: string): Promise<Uint8Array> {
		const resource = this.toResource(path);
		try {
			const content = await this.fileService.readFile(resource);
			return content.value.buffer;
		} catch (e) {
			const exists = await this.fileService.exists(resource);
			if (exists) {
				throw e;
			}
		}
		return VSBuffer.fromString('').buffer;
	}

	writeFile(path: string, value: Uint8Array): Promise<void> {
		return this.fileService.writeFile(this.toResource(path), VSBuffer.wrap(value)).then(() => undefined);
	}

	async listFiles(path: string): Promise<string[]> {
		const result = await this.fileService.resolve(this.toResource(path));
		return result.children ? result.children.map(c => this.toPath(c.resource)!) : [];
	}

	deleteFile(path: string): Promise<void> {
		return this.fileService.del(this.toResource(path));
	}

	private toResource(path: string): URI {
		return resources.joinPath(this.userDataHome, path);
	}

	private toPath(resource: URI): string | undefined {
		const resourcePath = resource.toString();
		const userDataHomePath = this.userDataHome.toString();
		return startsWith(resourcePath, userDataHomePath) ? resourcePath.substr(userDataHomePath.length + 1) : undefined;
	}
}