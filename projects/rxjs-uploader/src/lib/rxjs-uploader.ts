import { uniq } from 'lodash';
import {
    BehaviorSubject,
    combineLatest,
    from as observableFrom,
    fromEvent,
    merge,
    MonoTypeOperatorFunction,
    Observable,
    of as observableOf,
    Subject,
    Subscription,
    OperatorFunction
} from 'rxjs';
import { delay, filter, flatMap, map, scan, switchMap, take, takeUntil } from 'rxjs/operators';
import { ProgressState } from './constants/progress-state';
import { FileUpload } from './models/file-upload';
import { IUploadRequestOptions } from './models/upload-request-options';
import { UploaderError, FileSizeLimitExceededError } from './models/uploader-error';
import { DisallowedContentTypeError, MissingRequestOptionsError } from './models/uploader-error';
import { IUploaderConfig } from './models/uploader-config';

/** @see https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/readyState */
export const enum XHRReadyState {
    UNSENT = 0,
    OPENED = 1,
    HEADERS_RECEIVED = 2,
    LOADING = 3,
    DONE = 4
}
export type FileUploadSubjectsMap = Map<Symbol, BehaviorSubject<FileUpload>>;
export type DropZoneTarget = HTMLElement | Document | Window;
export type FileSource = HTMLInputElement | DropZoneTarget;

const BYTES_PER_MB = 1000 * 1000;

export class Uploader<FileUploadType extends FileUpload = FileUpload> {
    private _isDraggedOverSubject = new BehaviorSubject<boolean>(false);
    private _fileInputElements: HTMLInputElement[] = [];
    private _fileDropZoneElements: DropZoneTarget[] = [];
    private _fileUploadSubjectsMap = new Map<Symbol, BehaviorSubject<FileUploadType>>();
    private _fileUploadsStreamResetSubject = new Subject<null>();
    private _errorSubject = new Subject<UploaderError>();
    private _areRequestOptionsSet = false;
    private _allowedContentTypes: string[] = ['*'];
    private _fileCountLimit: number | (() => number) = 0; // Anything falsy or < 1 means infinity.
    private _fileSizeLimitMb: number;
    private _onFileCountLimitExceeded: (fileCountLimit: number) => void;
    private _requestOptions: Partial<IUploadRequestOptions>;
    private _requestOptionsFactory: (fileUpload?: FileUploadType) => Promise<IUploadRequestOptions>;
    private _fileUploadType = FileUpload;
    private _allFilesQueuedCallback: (fileUploads: FileUploadType[]) => Promise<FileUploadType[]>;
    private _fileUploadedCallback: (fileUpload: FileUploadType) => Promise<FileUploadType>;
    private _allFilesUploadedCallback: (fileUploads: FileUploadType[]) => Promise<FileUploadType[]> | void;
    private _dropZoneEventListenersMap =
        new Map<DropZoneTarget, { [key: string]: (event: Event) => any }>();
    private _dragAndDropFlagSelector: string;
    private _subscriptions: Subscription[] = [];
    public isDraggedOverStream = this._isDraggedOverSubject.asObservable();
    public errorStream = this._errorSubject.asObservable();

    // Public API - helper methods.
    public static createFileInputElement(type: 'single' | 'multiple' = 'single', accept?: string, className?: string): HTMLInputElement {
        const existingFileInputElements = document.querySelectorAll(`.${className}`);
        if (!!existingFileInputElements && !!existingFileInputElements.length) {
            Array.from(existingFileInputElements).forEach((existingFileInputElement) => {
                document.body.removeChild(existingFileInputElement);
            });
        }
        const fileInputElement = document.createElement('input');
        if (className) {
            fileInputElement.className = className;
        }
        fileInputElement.setAttribute('type', 'file');
        if (type === 'multiple') {
            fileInputElement.setAttribute('multiple', 'multiple');
        }
        if (accept) {
            fileInputElement.setAttribute('accept', accept);
        }
        fileInputElement.style.display = 'none';
        document.body.appendChild(fileInputElement);
        return fileInputElement;
    }

    constructor(config?: IUploaderConfig<FileUploadType>) {
        this.errorStream.subscribe((error) => {
            console.error(`[RxJs Uploader] ${error}`);
        });

        if (config) {
            if (typeof config.allowedContentTypes !== 'undefined') {
                this.setAllowedContentTypes(config.allowedContentTypes);
            }
            if (typeof config.fileCountLimit !== 'undefined') {
                this.setFileCountLimit(config.fileCountLimit);
            }
            if (typeof config.fileSizeLimitMb !== 'undefined') {
                this.setFileSizeLimitMb(config.fileSizeLimitMb);
            }
            if (typeof config.onFileCountLimitExceeded !== 'undefined') {
                this.setOnFileCountLimitExceeded(config.onFileCountLimitExceeded);
            }
            if (typeof config.requestUrl !== 'undefined') {
                this.setRequestUrl(config.requestUrl);
            }
            if (typeof config.requestOptions !== 'undefined') {
                this.setRequestOptions(config.requestOptions);
            }
            if (typeof config.fileUploadType !== 'undefined') {
                this.setFileUploadType(config.fileUploadType);
            }
            if (typeof config.allFilesQueuedCallback !== 'undefined') {
                this.setAllFilesQueuedCallback(config.allFilesQueuedCallback);
            }
            if (typeof config.fileUploadedCallback !== 'undefined') {
                this.setFileUploadedCallback(config.fileUploadedCallback);
            }
            if (typeof config.allFilesUploadedCallback !== 'undefined') {
                this.setAllFilesUploadedCallback(config.allFilesUploadedCallback);
            }
            if (typeof config.dragAndDropFlagSelector !== 'undefined') {
                this.setDragAndDropFlagSelector(config.dragAndDropFlagSelector);
            }
        }
    }

    // Public API.
    /**
     * All-in-one method for uploading. Takes an array of `input[type="file"]`s and an optional array of
     * drop zone target elements and returns an observable of `FileUpload`s, executing the uploads immediately.
     */
    public streamFileUploads(...fileSources: FileSource[]): Observable<FileUploadType[]> {
        return this._streamFileUploads(
            this._registerSources(...fileSources)
        );
    }

    public clear(): void {
        this._fileUploadsStreamResetSubject.next(null);
        this._fileUploadSubjectsMap.clear();
        this._subscriptions.forEach((subscription) => subscription.unsubscribe());
        this._fileInputElements.forEach((inputElement) => {
            inputElement.value = '';
        });
    }

    // Builder methods.
    public setRequestUrl(url: string): this {
        if (!this._requestOptions) {
            this._requestOptions = {};
        }
        this._requestOptions = {
            ...this._requestOptions,
            url
        };
        this._areRequestOptionsSet = true;
        return this;
    }

    public setRequestOptions(
        factoryOrOptions?: IUploadRequestOptions | ((fileUpload?: FileUploadType) => Promise<IUploadRequestOptions>)
    ): this {
        if (typeof factoryOrOptions === 'function') {
            this._requestOptionsFactory = factoryOrOptions.bind(this);
        } else {
            this._requestOptions = factoryOrOptions;
        }
        this._areRequestOptionsSet = true;
        return this;
    }

    public setRequestOptionsFactory(
        factory: (fileUpload?: FileUploadType) => Promise<IUploadRequestOptions>
    ): this {
        this._requestOptionsFactory = factory;
        this._areRequestOptionsSet = true;
        return this;
    }

    public patchRequestOptions(requestOptionsPatch?: Partial<IUploadRequestOptions>): this {
        const { formData, url, method } = requestOptionsPatch;
        if (!this._requestOptions) {
            this._requestOptions = {};
        }
        if (requestOptionsPatch.formData) {
            this._requestOptions.formData = { ...formData };
        }
        if (requestOptionsPatch.url) {
            this._requestOptions.url = url;
        }
        if (requestOptionsPatch.method) {
            this._requestOptions.method = method;
        }
        return this;
    }

    public setAllowedContentTypes(contentTypes: string[]): this {
        this._allowedContentTypes = contentTypes;
        return this;
    }

    public setFileCountLimit(limit: number | (() => number)): this {
        this._fileCountLimit = limit;
        return this;
    }

    public setFileSizeLimitMb(limit: number): this {
        this._fileSizeLimitMb = limit;
        return this;
    }

    public setOnFileCountLimitExceeded(fn: (fileCountLimit: number) => void): this {
        this._onFileCountLimitExceeded = fn;
        return this;
    }

    public setAllFilesQueuedCallback(callback: (fileUploads: FileUploadType[]) => Promise<FileUploadType[]>): this {
        this._allFilesQueuedCallback = callback;
        return this;
    }

    public setFileUploadedCallback(callback: (fileUpload: FileUploadType) => Promise<FileUploadType>): this {
        this._fileUploadedCallback = callback;
        return this;
    }

    public setAllFilesUploadedCallback(callback: (fileUploads: FileUploadType[]) => Promise<FileUploadType[]> | void): this {
        this._allFilesUploadedCallback = callback;
        return this;
    }

    public setDragAndDropFlagSelector(selector: string): this {
        this._dragAndDropFlagSelector = selector;
        return this;
    }

    public setFileUploadType(fileUploadType: any): this {
        this._fileUploadType = fileUploadType;
        return this;
    }

    // Getters.
    public getRequestUrl(): string {
        return this._requestOptions.url;
    }

    public getRequestOptions(): Partial<IUploadRequestOptions> {
        return this._requestOptions;
    }

    public getAllowedContentTypes(): string[] {
        return this._allowedContentTypes;
    }

    public getFileCountLimit(): number | (() => number) {
        return this._fileCountLimit;
    }

    public getFileSizeLimitMb(): number {
        return this._fileSizeLimitMb;
    }

    public getOnFileCountLimitExceeded(): (fileCountLimit: number) => void {
        return this._onFileCountLimitExceeded;
    }

    public getAllFilesQueuedCallback(): (fileUploads: FileUploadType[]) => Promise<FileUploadType[]> {
        return this._allFilesQueuedCallback;
    }

    public getFileUploadedCallback(): (fileUpload: FileUploadType) => Promise<FileUploadType> {
        return this._fileUploadedCallback;
    }

    public getAllFilesUploadedCallback(): (fileUploads: FileUploadType[]) => Promise<FileUploadType[]> | void {
        return this._allFilesUploadedCallback;
    }

    public getDragAndDropFlagSelector(): string {
        return this._dragAndDropFlagSelector;
    }

    public getFileUploadType(): any {
        return this._fileUploadType;
    }

    // Private methods.
    private _registerSources(...elements: FileSource[]): Observable<FileUploadType[]> {
        const inputElements = elements.filter((element: HTMLInputElement) =>
            element.type && element.type === 'file');
        const dropZoneElements = elements.filter((element: HTMLInputElement) =>
            !element.type || element.type !== 'file');
        const mergeArgs: Observable<FileUploadType[] | null>[] = [];

        if ((!inputElements || !inputElements.length) && (!dropZoneElements || !dropZoneElements.length)) {
            throw new Error('You must pass in at least one file source.');
        }
        if (inputElements && typeof inputElements.forEach === 'function') {
            inputElements.forEach((inputElement: HTMLInputElement) => {
                const inputElementStream = this._registerInput(inputElement);
                mergeArgs.push(inputElementStream);
            });
        }
        if (dropZoneElements && typeof dropZoneElements.forEach === 'function') {
            dropZoneElements.forEach((element) => {
                const dropZoneElementStream = this._registerDropZone(element);
                mergeArgs.push(dropZoneElementStream);
            });
        }

        if (this._isSingleFileInput()) {
            this.setFileCountLimit(1);
        }

        mergeArgs.push(this._fileUploadsStreamResetSubject.asObservable());

        return merge(...mergeArgs)
            .pipe(this._concatFileUploadArrays());
    }

    private _isSingleFileInput(): boolean {
        return this._fileInputElements.every((fileInputElement) => !fileInputElement.multiple);
    }

    private _registerInput(inputElement: HTMLInputElement): Observable<FileUploadType[]> {
        const fileUploadsSubject = new Subject<FileUploadType[]>();
        this._fileInputElements = uniq([...this._fileInputElements, inputElement]);

        if (this._allowedContentTypes.length && this._allowedContentTypes.indexOf('*') === -1) {
            this._fileInputElements.forEach((fileInputElement) => {
                fileInputElement.setAttribute('accept', this.getInputAccept());
            });
        }

        fromEvent(inputElement, 'change').subscribe(async () => {
            if (this._isSingleFileInput()) {
                fileUploadsSubject.next([]);
            }
            fileUploadsSubject.next(
                await this._handleFilesAdded(inputElement)
            );
            // Setting `value` to '' makes it so 'change' fires even if they select the
            // same file again.
            inputElement.value = '';
        });
        return fileUploadsSubject.asObservable()
            .pipe(map((fileUploads) => fileUploads.filter((fileUpload) => !fileUpload.isMarkedForRemoval)));
    }

    private _registerDropZone(element: DropZoneTarget = document): Observable<FileUploadType[]> {
        const fileUploadsSubject = new Subject<FileUploadType[]>();
        this._fileDropZoneElements = uniq([...this._fileDropZoneElements, element]);
        let eventListenersMap: { [key: string]: (event: Event) => any };
        if (this._dropZoneEventListenersMap.has(element)) {
            eventListenersMap = this._dropZoneEventListenersMap.get(element);
        } else {
            this._dropZoneEventListenersMap.set(element, {});
            eventListenersMap = this._dropZoneEventListenersMap.get(element);
            eventListenersMap.dragenter = (e) => this._stopDragEvent(e);
            eventListenersMap.dragover = (e: MouseEvent) => this._handleDragOver(e);
            eventListenersMap.dragleave = (e) => this._handleDragLeave(e);
            eventListenersMap.drop = async (e) => {
                fileUploadsSubject.next(await this._handleDrop(e));
            };
            Object.keys(eventListenersMap).forEach((eventName) => {
                element.addEventListener(eventName, eventListenersMap[eventName], false);
            });
        }
        this._fileUploadsStreamResetSubject.subscribe(() => {
            eventListenersMap = this._dropZoneEventListenersMap.get(element);
            if (eventListenersMap) {
                Object.keys(eventListenersMap).forEach((eventName) => {
                    element.removeEventListener(eventName, eventListenersMap[eventName]);
                });
            }
        });
        return fileUploadsSubject.asObservable()
            .pipe(map((fileUploads) => fileUploads.filter((fileUpload) => !fileUpload.isMarkedForRemoval)));
    }

    private _subscribeTemporarily<T = any>(
        observable: Observable<T>,
        successCallback: (value: T) => any,
        errorCallback?: (...args: any[]) => any
    ): void {
        this._subscriptions.push(
            observable.subscribe(
                (value) => successCallback(value),
                (...args) => typeof errorCallback === 'function' ? errorCallback(...args) : {}
            )
        );
    }

    private _createFileUploads(_files: File[] | FileList): Observable<FileUploadType[]> {
        let files: File[] = _files as File[];
        if (_files instanceof FileList) {
            files = Array.from(_files);
        }
        // Filter out disallowed file types/sizes.
        const allowedFiles: File[] = [];
        for (const file of files) {
            const mimeType = file.type;
            // First, check if the file is under the size limit.
            if (!this._fileSizeLimitMb || file.size < this._fileSizeLimitMb * BYTES_PER_MB) {
                // Then, check if the file type is supported.
                if (!!this._allowedContentTypes.find((contentType) => contentType === '*')
                    || this._allowedContentTypes.some((contentType) => contentType === mimeType)) {
                    allowedFiles.push(file);
                } else {
                    this._errorSubject.next(new DisallowedContentTypeError(
                        `${file.name} failed to upload because its content type, ${mimeType}, is not allowed.`
                    ));
                }
            } else {
                this._errorSubject.next(new FileSizeLimitExceededError(
                    `${file.name} is larger than the limit of ${this._fileSizeLimitMb}MB for a single file. Please compress or split the file into smaller files.`
                ));
            }
        }
        const fileUploads = uniq(allowedFiles).map((file: File) => {
            const initialFileUpload = new this._fileUploadType(file) as FileUploadType;
            const fileUploadSubject = new BehaviorSubject<FileUploadType>(initialFileUpload);
            this._fileUploadSubjectsMap.set(initialFileUpload.id, fileUploadSubject);

            return initialFileUpload;
        });

        return observableOf(fileUploads);
    }

    private _streamFileUploads(fileUploadsStream: Observable<FileUploadType[]>): Observable<FileUploadType[]> {
        return merge(
            fileUploadsStream,
            this._fileUploadsStreamResetSubject.asObservable(),
            fileUploadsStream.pipe(this._mergeIsMarkedForRemovalStreams())
        )
            .pipe(
                this._concatFileUploadArrays(),
                flatMap((fileUploads) => {
                    // If we have a callback to invoke, return an observable of the callback mapped to
                    // the result of `_executeFileUploads`. Else, just return the result of
                    // `_executeFileUploads`.
                    if (typeof this._allFilesQueuedCallback === 'function') {
                        return observableFrom(this._allFilesQueuedCallback(fileUploads))
                            .pipe(flatMap((_fileUploads) =>
                                this._executeFileUploads(_fileUploads)
                            ));
                    } else {
                        return this._executeFileUploads(fileUploads);
                    }
                }),
                this._concatFileUploadArrays(),
            );
    }

    private _createExecutedFileUploadsStream(_fileUploads: FileUploadType[]): Observable<FileUploadType[]> {
        const fileUploadStreams = _fileUploads
            .map((fileUpload) => {
                if (!fileUpload.uploadHasStarted) {
                    return this._executeFileUpload(fileUpload);
                } else {
                    return observableOf(fileUpload);
                }
            });
        return combineLatest(fileUploadStreams);
    }

    private _executeFileUploads(fileUploads: FileUploadType[]): Observable<FileUploadType[]> {
        if (fileUploads === null || fileUploads.length === 0) {
            return observableOf(fileUploads);
        }

        let fileUploadsStream = this._createExecutedFileUploadsStream(fileUploads);

        if (typeof this._allFilesUploadedCallback === 'function') {
            fileUploadsStream = fileUploadsStream
                .pipe(
                    switchMap((_fileUploads) => {
                        if (_fileUploads.every((fileUpload) => fileUpload.uploaded)) {
                            const promiseOrVoid = this._allFilesUploadedCallback(_fileUploads);
                            if (promiseOrVoid instanceof Promise) {
                                return observableFrom(promiseOrVoid);
                            } else {
                                return observableOf(_fileUploads);
                            }
                        }
                        return observableOf(_fileUploads);
                    })
                );
        }

        return fileUploadsStream;
    }

    private _uploadFile(fileUpload: FileUploadType): Observable<FileUploadType> {
        const fileUploadSubject = this._fileUploadSubjectsMap.get(fileUpload.id);
        const request = fileUpload.createRequest();
        const handleError = (errorResponse: any): void => {
            const _fileUpload = fileUploadSubject.getValue();
            _fileUpload.progress = {
                percent: 100,
                state: ProgressState.Failed
            };

            if (errorResponse) {
                _fileUpload.responseBody = errorResponse;
                _fileUpload.responseCode = errorResponse.status || errorResponse.code;
                this._errorSubject.next(errorResponse);
            }

            fileUploadSubject.next(_fileUpload);
        };

        this._subscribeTemporarily(
            fileUpload.executeStream.pipe(filter((shouldExecute) => shouldExecute)),
            () => {
                const xhr = new XMLHttpRequest();
                const progressStream = fromEvent(xhr.upload, 'progress');
                const completedStream = fromEvent(xhr, 'load');
                const xhrErrorStream = fromEvent(xhr, 'error');
                xhr.withCredentials = false;

                this._subscribeTemporarily(
                    merge(progressStream, completedStream)
                        .pipe(
                            delay(0),
                            takeUntil(this._fileUploadsStreamResetSubject.asObservable())
                        ),
                    async (event: ProgressEvent) => {
                        const _fileUpload = fileUploadSubject.getValue();
                        const progressPercent = Math.round(100 * event.loaded / event.total);
                        if (xhr.readyState !== XHRReadyState.DONE && typeof progressPercent === 'number') {
                            _fileUpload.progress = {
                                percent: progressPercent,
                                state: ProgressState.InProgress
                            };
                            fileUploadSubject.next(_fileUpload);
                        } else if (
                            xhr.readyState === XHRReadyState.DONE
                            && _fileUpload.progress.state !== ProgressState.Completed
                        ) {
                            // The upload is complete.
                            let response: any;
                            try {
                                response = JSON.parse(xhr.response);
                            } catch (_error) {
                                response = xhr.response;
                            }
                            _fileUpload.progress = {
                                percent: 100,
                                state: ProgressState.Completed
                            };
                            _fileUpload.response = new Response(response, {
                                status: xhr.status,
                                statusText: xhr.statusText
                            });
                            _fileUpload.responseBody = response;
                            _fileUpload.responseCode = xhr.status;

                            if (typeof this._fileUploadedCallback === 'function') {
                                fileUploadSubject.next(await this._fileUploadedCallback(_fileUpload));
                            } else {
                                fileUploadSubject.next(_fileUpload);
                            }
                        }
                    },
                    (errorResponse) => handleError(errorResponse)
                );

                this._subscribeTemporarily(xhrErrorStream, (xhrError) => {
                    let errorMessage: any;
                    try {
                        errorMessage = JSON.stringify(xhrError);
                    } catch (error) {
                        errorMessage = 'There was an error serializing the error response.';
                    }
                    handleError(new Error(errorMessage));
                });

                xhr.open(request.method, request.url, true);
                if (fileUpload.requestOptions.headers) {
                    Object.keys(fileUpload.requestOptions.headers).forEach((key) => {
                        const value = fileUpload.requestOptions.headers[key];
                        xhr.setRequestHeader(key, value);
                    });
                }
                xhr.send(request.body);

                fileUpload.isMarkedForRemovalStream
                    .pipe(
                        filter((isMarkedForRemoval) => isMarkedForRemoval),
                        take(1)
                    )
                    .subscribe(() => xhr.abort());

                this._fileUploadsStreamResetSubject
                    .pipe(take(1))
                    .subscribe(() => xhr.abort());
            });

        return fileUploadSubject.asObservable();
    }

    private _executeFileUpload(fileUploadToExecute: FileUploadType): Observable<FileUploadType> {
        if (!this._areRequestOptionsSet) {
            throw new MissingRequestOptionsError(
                'Uploading is not allowed until request options are set using `setRequestOptions`'
            );
        }

        // The upload is now considered started (even though no XHR stuff has happened yet).
        const fileUploadSubject = this._fileUploadSubjectsMap.get(fileUploadToExecute.id);
        fileUploadToExecute.uploadHasStarted = true;
        fileUploadSubject.next(fileUploadToExecute);

        // Construct a request and send it.
        if (typeof this._requestOptionsFactory === 'function') {
            const existingRequestOptions: Partial<IUploadRequestOptions> = this._requestOptions || {};
            this._requestOptionsFactory(fileUploadToExecute)
                .then((requestOptions) => {
                    if (requestOptions) {
                        fileUploadToExecute.setRequestOptions({
                            ...requestOptions,
                            ...existingRequestOptions,
                            formData: {
                                ...requestOptions.formData,
                                ...existingRequestOptions.formData
                            }
                        });
                    }
                    this._uploadFile(fileUploadToExecute);
                });
        } else {
            fileUploadToExecute.setRequestOptions(this._requestOptions as IUploadRequestOptions);
            this._uploadFile(fileUploadToExecute);
        }

        return fileUploadSubject.asObservable();
    }

    // Accessors.
    public getInputAccept(): string {
        return this._allowedContentTypes.join(',');
    }

    // Event handlers.
    private _handleDragOver(event: MouseEvent): void {
        if (this._canDragAndDrop()) {
            this._stopDragEvent(event);
            this._isDraggedOverSubject.next(true);
        }
    }

    private async _handleDrop(event: any): Promise<FileUploadType[]> {
        if (this._canDragAndDrop()) {
            this._stopDragEvent(event);
            this._isDraggedOverSubject.next(false);
            return await this._createFileUploads(event.dataTransfer.files).toPromise();
        }
        return [];
    }

    private _handleDragLeave(event: Event): void {
        if (this._canDragAndDrop()) {
            this._stopDragEvent(event);
            this._isDraggedOverSubject.next(false);
        }
    }

    private _handleFilesAdded(inputElement: HTMLInputElement): Promise<FileUploadType[]> {
        const files = Array.from(inputElement.files);
        return this._createFileUploads(files).toPromise();
    }

    // Helpers.
    private _stopEvent(event: Event): void {
        event.stopImmediatePropagation();
        event.preventDefault();
    }

    private _stopDragEvent(event: Event): void {
        if (this._canDragAndDrop()) {
            return this._stopEvent(event);
        }
    }

    private _canDragAndDrop(): boolean {
        return !this._dragAndDropFlagSelector
            || !!document.querySelector(this._dragAndDropFlagSelector);
    }

    private _getFileCountLimit(): number {
        switch (typeof this._fileCountLimit) {
            case 'number':
                return this._fileCountLimit as number;
            case 'function':
                return (this._fileCountLimit as () => number)();
            default:
                return 0;
        }
    }

    private _exceedsFileCountLimit(fileUploads: FileUploadType[]): boolean {
        const fileCountLimit = this._getFileCountLimit();

        if (
            !!fileUploads
            && fileCountLimit > 0
            && fileUploads.length > fileCountLimit
        ) {
            return true;
        }

        return false;
    }

    private _mergeIsMarkedForRemovalStreams(): OperatorFunction<FileUploadType[], FileUploadType[]> {
        return flatMap<FileUploadType[], FileUploadType[]>((fileUploads) => merge(
            ...fileUploads.map((fileUpload) =>
                fileUpload.isMarkedForRemovalStream.pipe(
                    filter((isMarkedForRemoval) => isMarkedForRemoval),
                    map(() => fileUploads)
                )
            )
        ));
    }

    private _concatFileUploadArrays(): MonoTypeOperatorFunction<FileUploadType[]> {
        // This `scan` (which behaves similarly to `Array.prototype.reduce`) does the bulk
        // of state management for `Uploader`.
        //   - If our `fileUploadsStream` is coming from a file input's `change` event,
        //     we'll be receiving a new array based on `input.files` any time that `change`
        //     event fires. So we might get `[fileUpload1]`, then `[fileUpload1, fileUpload2]`,
        //     etc. But, since each `FileUpload` has a unique `id`, we can de-dupe--that
        //     happens here.
        //   - If the number of `FileUpload`s exceeds the file count limit, mark all
        //     newly-added ones for removal (already-executed uploads are left alone).
        //   - If the new accumulated array exceeds the file count limit, invoke the callback
        //     (and make sure it's only invoked once per attempt).
        return scan<FileUploadType[]>((_previousAccFileUploads, _currentFileUploads) => {
            if (
                _currentFileUploads === null
                || (this._isSingleFileInput() && !_currentFileUploads.length)
            ) {
                return [];
            } else {
                _currentFileUploads.forEach((fileUpload) => {
                    if (fileUpload.isMarkedForRemoval) {
                        this._fileUploadSubjectsMap.delete(fileUpload.id);
                    }
                });
            }

            const previousAccFileUploads = _previousAccFileUploads
                .filter((fileUpload) => !fileUpload.isMarkedForRemoval);
            const currentFileUploads = _currentFileUploads
                .filter((fileUpload) => !fileUpload.isMarkedForRemoval);
            const accFileUploads = uniq([ ...previousAccFileUploads, ...currentFileUploads ]);
            const newFileUploads = currentFileUploads
                .filter((currentFileUpload) => !previousAccFileUploads
                    .find((fileUpload) => fileUpload.id === currentFileUpload.id));

            // If the number of file uploads exceeds the limit, remove all the newly-added
            // uploads.
            if (
                this._exceedsFileCountLimit(currentFileUploads)
                || this._exceedsFileCountLimit(accFileUploads)
            ) {
                newFileUploads.forEach((fileUpload) => {
                    fileUpload.markForRemoval();
                });

                this._onFileCountLimitExceeded(this._getFileCountLimit());
                return previousAccFileUploads;
            }

            return accFileUploads;
        }, []);
    }
}
