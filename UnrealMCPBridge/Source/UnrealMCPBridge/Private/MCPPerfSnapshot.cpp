// What a running game costs, per frame and on the wire.
//
// "Will this run on a cheap laptop" was answered by opinion. The engine already knows the frame's
// game, render and GPU time, which actors tick every frame, and how many bytes each client is sent,
// so this reads those during Play In Editor and hands them back as numbers. It is a snapshot, not a
// profiler: enough to see that 200 actors of one class tick every frame, or that a client is being
// sent 40 KB/s, without opening Insights.

#include "MCPCommandHandler.h"

#include "MCPResponse.h"

#include "Engine/Engine.h"
#include "Engine/World.h"
#include "Engine/NetDriver.h"
#include "Engine/NetConnection.h"
#include "EngineUtils.h"
#include "GameFramework/Actor.h"
#include "Misc/App.h"
#include "RenderCore.h"
#include "RHI.h"

namespace
{
	double CyclesToMs(uint32 Cycles)
	{
		return FPlatformTime::ToMilliseconds(Cycles);
	}

	FString RoleOfWorld(const FWorldContext& Context, UWorld* World)
	{
		return World->GetNetMode() == NM_Client
			? FString::Printf(TEXT("Client%d"), FMath::Max(0, Context.PIEInstance - 1))
			: TEXT("Authority");
	}
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandlePerfSnapshot(const TSharedPtr<FJsonObject>& Params)
{
	int32 TopClasses = 12;
	if (Params.IsValid())
	{
		double Requested = 0;
		if (Params->TryGetNumberField(TEXT("topClasses"), Requested) && Requested >= 1)
		{
			TopClasses = FMath::Min(50, static_cast<int32>(Requested));
		}
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();

	// The editor's own stat unit numbers. In PIE they include the editor around the game, so they
	// are an upper bound on what a packaged build costs, not the figure itself.
	TSharedRef<FJsonObject> Frame = MakeShared<FJsonObject>();
	Frame->SetNumberField(TEXT("frameMs"), FMath::RoundToDouble(FApp::GetDeltaTime() * 10000.0) / 10.0);
	Frame->SetNumberField(TEXT("gameThreadMs"), FMath::RoundToDouble(CyclesToMs(GGameThreadTime) * 10.0) / 10.0);
	Frame->SetNumberField(TEXT("renderThreadMs"), FMath::RoundToDouble(CyclesToMs(GRenderThreadTime) * 10.0) / 10.0);
	Frame->SetNumberField(TEXT("gpuMs"), FMath::RoundToDouble(CyclesToMs(RHIGetGPUFrameCycles()) * 10.0) / 10.0);
	Result->SetObjectField(TEXT("frame"), Frame);

	TArray<TSharedPtr<FJsonValue>> Worlds;
	bool bAnyPie = false;
	if (GEngine)
	{
		for (const FWorldContext& Context : GEngine->GetWorldContexts())
		{
			if (Context.WorldType != EWorldType::PIE || !Context.World())
			{
				continue;
			}
			bAnyPie = true;
			UWorld* World = Context.World();

			// Ticking actors per class: how many tick at all, and how many of those tick every frame.
			struct FClassTicks
			{
				int32 Actors = 0;
				int32 Ticking = 0;
				int32 EveryFrame = 0;
			};
			TMap<FString, FClassTicks> ByClass;
			int32 ActorCount = 0;
			int32 EveryFrameTotal = 0;
			for (TActorIterator<AActor> It(World); It; ++It)
			{
				AActor* Actor = *It;
				if (!Actor)
				{
					continue;
				}
				++ActorCount;
				FClassTicks& Entry = ByClass.FindOrAdd(Actor->GetClass()->GetName());
				++Entry.Actors;
				if (Actor->PrimaryActorTick.IsTickFunctionEnabled())
				{
					++Entry.Ticking;
					if (Actor->PrimaryActorTick.TickInterval <= 0.f)
					{
						++Entry.EveryFrame;
						++EveryFrameTotal;
					}
				}
			}
			ByClass.ValueSort([](const FClassTicks& A, const FClassTicks& B) { return A.EveryFrame > B.EveryFrame; });

			TArray<TSharedPtr<FJsonValue>> Classes;
			for (const TPair<FString, FClassTicks>& Pair : ByClass)
			{
				if (Pair.Value.EveryFrame == 0 || Classes.Num() >= TopClasses)
				{
					break;
				}
				TSharedRef<FJsonObject> Row = MakeShared<FJsonObject>();
				Row->SetStringField(TEXT("class"), Pair.Key);
				Row->SetNumberField(TEXT("actors"), Pair.Value.Actors);
				Row->SetNumberField(TEXT("tickEveryFrame"), Pair.Value.EveryFrame);
				Classes.Add(MakeShared<FJsonValueObject>(Row));
			}

			TSharedRef<FJsonObject> WorldEntry = MakeShared<FJsonObject>();
			WorldEntry->SetStringField(TEXT("role"), RoleOfWorld(Context, World));
			WorldEntry->SetNumberField(TEXT("actors"), ActorCount);
			WorldEntry->SetNumberField(TEXT("actorsTickingEveryFrame"), EveryFrameTotal);
			WorldEntry->SetArrayField(TEXT("everyFrameByClass"), Classes);

			// Bandwidth per client, from the server side, where it is spent.
			if (UNetDriver* Driver = World->GetNetDriver())
			{
				if (World->GetNetMode() != NM_Client)
				{
					TArray<TSharedPtr<FJsonValue>> Clients;
					for (UNetConnection* Connection : Driver->ClientConnections)
					{
						if (!Connection)
						{
							continue;
						}
						TSharedRef<FJsonObject> Net = MakeShared<FJsonObject>();
						Net->SetNumberField(TEXT("outBytesPerSec"), Connection->OutBytesPerSecond);
						Net->SetNumberField(TEXT("inBytesPerSec"), Connection->InBytesPerSecond);
						Clients.Add(MakeShared<FJsonValueObject>(Net));
					}
					WorldEntry->SetArrayField(TEXT("clients"), Clients);
				}
			}
			Worlds.Add(MakeShared<FJsonValueObject>(WorldEntry));
		}
	}

	Result->SetBoolField(TEXT("pie"), bAnyPie);
	Result->SetArrayField(TEXT("worlds"), Worlds);
	if (!bAnyPie)
	{
		Result->SetStringField(TEXT("note"),
			TEXT("No Play In Editor session is running, so only the editor's own frame times are shown. Start PIE first."));
	}
	return MCPResponse::Ok(Result);
}
