#include <windows.h>
#include <stdio.h>
#include <stdlib.h>

typedef int (__stdcall *studio_create_fn)(void **, unsigned int);
typedef int (__stdcall *studio_get_core_fn)(void *, void **);
typedef int (__stdcall *core_set_output_fn)(void *, int);
typedef int (__stdcall *studio_initialize_fn)(void *, int, unsigned int, unsigned int, void *);
typedef int (__stdcall *studio_load_bank_fn)(void *, const char *, unsigned int, void **);
typedef int (__stdcall *bank_load_samples_fn)(void *);
typedef int (__stdcall *studio_flush_samples_fn)(void *);
typedef int (__stdcall *studio_get_event_fn)(void *, const char *, void **);
typedef int (__stdcall *event_load_samples_fn)(void *);
typedef int (__stdcall *event_create_instance_fn)(void *, void **);
typedef struct { float x; float y; float z; } fmod_vector;
typedef struct { fmod_vector position; fmod_vector velocity; fmod_vector forward; fmod_vector up; } fmod_3d_attributes;
typedef int (__stdcall *studio_set_listener_fn)(void *, int, const fmod_3d_attributes *, const fmod_vector *);
typedef int (__stdcall *event_set_3d_fn)(void *, const fmod_3d_attributes *);
typedef int (__stdcall *event_start_fn)(void *);
typedef int (__stdcall *studio_update_fn)(void *);
typedef int (__stdcall *event_release_fn)(void *);
typedef int (__stdcall *studio_release_fn)(void *);

static int check(int result, const char *operation) {
    if (result != 0) {
        fprintf(stderr, "%s failed with FMOD result %d\n", operation, result);
        return 0;
    }
    return 1;
}

#define LOAD(dll, type, name) type name = (type)GetProcAddress(dll, #name); if (!name) { fprintf(stderr, "Missing export: %s\n", #name); return 2; }

int main(int argc, char **argv) {
    HMODULE core_dll;
    HMODULE studio_dll;
    void *system = NULL;
    void *core = NULL;
    void *bank = NULL;
    void *event = NULL;
    void *instance = NULL;
    fmod_3d_attributes attributes = { 0 };
    double seconds;
    int updates;
    int index;

    if (argc < 7) {
        fprintf(stderr, "Usage: render_noita_event <dll-dir> <event-path> <output.wav> <seconds> <master.bank> <strings.bank> [event.bank ...]\n");
        return 1;
    }

    seconds = strtod(argv[4], NULL);
    if (seconds <= 0.0 || seconds > 3600.0) {
        fprintf(stderr, "Seconds must be greater than 0 and no more than 3600.\n");
        return 1;
    }
    updates = (int)(seconds * 46.875) + 2;

    SetDllDirectoryA(argv[1]);
    core_dll = LoadLibraryA("fmod.dll");
    studio_dll = LoadLibraryA("fmodstudio.dll");
    if (!core_dll || !studio_dll) {
        fprintf(stderr, "Unable to load Noita FMOD DLLs (%lu)\n", GetLastError());
        return 2;
    }

    LOAD(studio_dll, studio_create_fn, FMOD_Studio_System_Create);
    LOAD(studio_dll, studio_get_core_fn, FMOD_Studio_System_GetCoreSystem);
    LOAD(core_dll, core_set_output_fn, FMOD_System_SetOutput);
    LOAD(studio_dll, studio_initialize_fn, FMOD_Studio_System_Initialize);
    LOAD(studio_dll, studio_load_bank_fn, FMOD_Studio_System_LoadBankFile);
    LOAD(studio_dll, bank_load_samples_fn, FMOD_Studio_Bank_LoadSampleData);
    LOAD(studio_dll, studio_flush_samples_fn, FMOD_Studio_System_FlushSampleLoading);
    LOAD(studio_dll, studio_get_event_fn, FMOD_Studio_System_GetEvent);
    LOAD(studio_dll, event_load_samples_fn, FMOD_Studio_EventDescription_LoadSampleData);
    LOAD(studio_dll, event_create_instance_fn, FMOD_Studio_EventDescription_CreateInstance);
    LOAD(studio_dll, studio_set_listener_fn, FMOD_Studio_System_SetListenerAttributes);
    LOAD(studio_dll, event_set_3d_fn, FMOD_Studio_EventInstance_Set3DAttributes);
    LOAD(studio_dll, event_start_fn, FMOD_Studio_EventInstance_Start);
    LOAD(studio_dll, studio_update_fn, FMOD_Studio_System_Update);
    LOAD(studio_dll, event_release_fn, FMOD_Studio_EventInstance_Release);
    LOAD(studio_dll, studio_release_fn, FMOD_Studio_System_Release);

    if (!check(FMOD_Studio_System_Create(&system, 0x00020105), "create system")) return 3;
    if (!check(FMOD_Studio_System_GetCoreSystem(system, &core), "get core system")) return 3;
    if (!check(FMOD_System_SetOutput(core, 5), "select WAV writer NRT")) return 3;
    if (!check(FMOD_Studio_System_Initialize(system, 128, 0x00000004, 0x00000003, argv[3]), "initialize")) return 3;

    attributes.forward.z = 1.0f;
    attributes.up.y = 1.0f;
    if (!check(FMOD_Studio_System_SetListenerAttributes(system, 0, &attributes, NULL), "set listener")) return 3;

    for (index = 5; index < argc; index += 1) {
        if (!check(FMOD_Studio_System_LoadBankFile(system, argv[index], 0, &bank), "load bank")) return 4;
        if (!check(FMOD_Studio_Bank_LoadSampleData(bank), "load bank samples")) return 4;
    }
    if (!check(FMOD_Studio_System_FlushSampleLoading(system), "flush sample loading")) return 4;
    if (!check(FMOD_Studio_System_GetEvent(system, argv[2], &event), "get event")) return 5;
    if (!check(FMOD_Studio_EventDescription_LoadSampleData(event), "load event samples")) return 5;
    if (!check(FMOD_Studio_System_FlushSampleLoading(system), "flush event samples")) return 5;
    if (!check(FMOD_Studio_EventDescription_CreateInstance(event, &instance), "create event instance")) return 5;
    if (!check(FMOD_Studio_EventInstance_Set3DAttributes(instance, &attributes), "set event position")) return 5;
    if (!check(FMOD_Studio_EventInstance_Start(instance), "start event")) return 5;

    for (index = 0; index < updates; index += 1) {
        if (!check(FMOD_Studio_System_Update(system), "update")) return 6;
    }

    FMOD_Studio_EventInstance_Release(instance);
    FMOD_Studio_System_Release(system);
    FreeLibrary(studio_dll);
    FreeLibrary(core_dll);
    return 0;
}
